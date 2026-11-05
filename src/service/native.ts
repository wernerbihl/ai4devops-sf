import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Attempt, NativeIdentity, NativeStart, OwnerEvent, RequiredCapabilities, TaskSpec } from '../contracts/domain.ts';
import type { NativeOwner } from '../contracts/owner.ts';
import type { Installation } from '../kestra/deployment.ts';
import { dockerBind, ProcessDocker } from '../kestra/deployment.ts';
import { privateDirectory } from '../kestra/executions.ts';
import type { FactoryStore } from '../storage/store.ts';
import type { AttemptBroker } from '../broker/operations.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import { createFactoryToolGate } from '../owners/tools.ts';
import { createVsCodeOwner } from '../owners/vscode.ts';
import { createManagedVsCodeLauncher } from '../owners/managed.ts';
import { createIsolatedNativeBoundary, isolatedToolAllowlist } from '../owners/isolated.ts';
import { IsolatedToolWorker, createIsolatedClientTools } from '../owners/worker.ts';
import { createProfileVerifier } from '../isolation/verify.ts';
import { NATIVE_STATE_TARGET, type NativeStateMount } from '../isolation/native-state.ts';
import { resolveNativeMounts } from '../isolation/mounts.ts';
import type { NativeModelProxyControl, ModelProxyPolicy } from '../owners/model-proxy.ts';
import { imageMatches } from '../isolation/image.ts';
import { expectedImageBuild } from '../install/images.ts';
import { proxyTopology } from './proxy-topology.ts';
import { createProxyPlaceholder, finalizeProxyPolicy } from './proxy-policy.ts';
import type { RuntimeConfig, IsolatedNativeTemplate } from './config.ts';
import { readPrivateFile } from './config.ts';
import { loadCompanionCredential } from '../install/companion-auth.ts';
import { navigationCommits } from '../owners/navigation.ts';
import { createDesktopNavigation } from '../owners/desktop.ts';
export const isolatedProfileId = 'vscode-copilot-isolated-worker-v2';
const workerEnv = ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8'];
const nativeEnv = ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/opt/software-factory/empty-home','LANG=C.UTF-8','SF_CONTROL_SENTINEL=sf-nonsecret-control-sentinel'];
const curatedModelAuthorities = new Set(['api.github.com:443','api.githubcopilot.com:443','copilot-proxy.githubusercontent.com:443']);
function reviewedProxyHash() {
  const source = new URL(import.meta.url.endsWith('.ts') ? '../../runtime/model-proxy/connect.cjs' : '../runtime/model-proxy/connect.cjs', import.meta.url);
  return createHash('sha256').update(readFileSync(source)).digest('hex');
}
export function createNativeFleet(options: { installation: Installation; config: RuntimeConfig; store: FactoryStore; broker: AttemptBroker; protectedPaths: string[] }) {
  const { installation, config, store, broker } = options; const docker = installation.docker;
  const listeners = new Set<(event: OwnerEvent) => void>();
  const members = new Map<string, Promise<Member>>();
  const template = config.native[0];
  function supports(task: TaskSpec) {
    ensure(template && task.ownerId === 'vscode' && task.providerId === 'copilot' && task.skills.length === 0, 'native_unsupported', 'Only configured isolated VS Code/Copilot is supported');
    isolatedToolAllowlist(task);
    const recipe = store.getRecipeRevision(task.recipeId, task.recipeRevision);
    ensure(recipe && Object.keys(recipe.skillVersions).length === 0 && task.required.tools.every(id => recipe.toolVersions[id] === '2'), 'native_toolkit_version', 'Approve a new exact recipe revision using isolated toolkit version 2; v1 is not reinterpreted');
    ensure((navigationCommits as readonly string[]).includes(template.hostCommit), 'native_version', 'Native host commit is not supported');
    return template;
  }
  async function templateReadiness(): Promise<string[]> {
    try {
      ensure(template, 'native_unconfigured', 'No isolated native template is configured');
      ensure(template.proxy.entrypointSha256 === reviewedProxyHash() && template.proxy.allowedAuthorities.length > 0 && template.proxy.allowedAuthorities.every(a => curatedModelAuthorities.has(a)), 'native_proxy', 'Reviewed model proxy source and curated authorities are required');
      const credential = config.providerCredentials.find(c => c.ref === template.credentialRef);
      ensure(credential && (credential.expiresAt === undefined || Date.parse(credential.expiresAt) > Date.now() + 30_000) && loadCompanionCredential(installation.root,credential).token.length > 0, 'native_auth', 'Current provider credential is unavailable');
      ensure((navigationCommits as readonly string[]).includes(template.hostCommit), 'native_version', 'Native host commit unsupported');
      for (const [role,image] of [['native',template.nativeImage],['worker',template.workerImage],['proxy',template.proxy.image]] as const) {
        const actual = JSON.parse(await docker.command(['image','inspect',image]))[0];
        ensure(imageMatches(image,actual) && actual.Os === 'linux' && actual.Architecture === 'amd64' && (!image.startsWith('sha256:') || actual.Config?.Labels?.['sf.installation'] === installation.id && actual.Config?.Labels?.['sf.build'] === expectedImageBuild().sourceFingerprint && actual.Config?.Labels?.['sf.role'] === role), 'native_image', 'Pinned native/worker/proxy image is unavailable or its owned build does not match');
      }
      return [];
    } catch (error) { return [error instanceof Error ? error.message : 'Native provisioning unavailable']; }
  }
  async function provisionability(task: TaskSpec): Promise<string[]> {
    try { supports(task); return templateReadiness(); }
    catch (error) { return [error instanceof Error ? error.message : 'Unsupported task capabilities']; }
  }

  async function inspect(kind: string, name: string) {
    try { return JSON.parse(await docker.command([kind,'inspect',name]))[0]; }
    catch { const listed = await docker.command([kind,'ls', ...(kind === 'container' ? ['--all'] : []), '--filter', 'name=^'+name+'$', '--format', '{{.ID}}']); ensure(!listed.trim(), 'native_unknown', 'Owned resource inspection is uncertain'); return undefined; }
  }
  async function network(name: string, internal: boolean, create: boolean) {
    let n = await inspect('network',name);
    if (!n && create) { try { await docker.command(['network','create',...(internal ? ['--internal'] : []),'--driver','bridge','--label','sf.installation='+installation.id,name]); } catch {} n = await inspect('network',name); }
    ensure(n?.Name === name && n.Internal === internal && n.Driver === 'bridge' && n.Labels?.['sf.installation'] === installation.id, 'native_network', 'Exact owned runtime network unavailable'); return n;
  }
  async function container(input: { name: string; image: string; role: 'native' | 'worker' | 'proxy'; owner: string; network: string; mounts: { source: string; target: string; writable: boolean }[]; env: string[]; cwd: string; command: string[]; create: boolean; alias?: string }) {
    const image = JSON.parse(await docker.command(['image','inspect',input.image]))[0];
    ensure(imageMatches(input.image,image) && (!input.image.startsWith('sha256:') || image.Config?.Labels?.['sf.installation'] === installation.id && image.Config?.Labels?.['sf.build'] === expectedImageBuild().sourceFingerprint && image.Config?.Labels?.['sf.role'] === input.role) && !image.Config.Entrypoint?.length && canonical(image.Config.Env ?? []) === canonical(input.env), 'native_image', 'Pinned image must declare exact minimal environment and no implicit entrypoint');
    const uid = process.platform==='win32'?1000:process.getuid!(); const gid = process.platform==='win32'?1000:process.getgid!(); ensure(uid > 0, 'native_user', 'Native runtimes require a nonroot installation');
    let c = await inspect('container',input.name);
    if (!c && input.create) {
      const action = store.enqueueAction({ key: 'runtime:container:'+input.name, kind: 'runtime.container', payload: { name: input.name, image: input.image, owner: input.owner } });
      try { await docker.command(['create','--name',input.name,'--pull','never','--platform','linux/amd64','--user',`${uid}:${gid}`,'--workdir',input.cwd,
        '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','2g','--cpus','2','--restart','no',
        '--tmpfs',`/tmp:rw,nosuid,nodev,noexec,uid=${uid},gid=${gid},mode=1777`,'--network',input.network,...(input.alias ? ['--network-alias',input.alias] : []),
        '--label','sf.installation='+installation.id,'--label','sf.runtime-owner='+input.owner,
        ...input.mounts.flatMap(m => ['--mount',dockerBind(m.source,m.target,!m.writable)]),input.image,...input.command]); } catch {}
      c = await inspect('container',input.name); if (c) store.completeAction(action.id);
    }
    ensure(c?.Image === image.Id && c.Config.Image === input.image && c.Config.Labels?.['sf.runtime-owner'] === input.owner && c.Config.User === `${uid}:${gid}`
      && c.Config.WorkingDir === input.cwd && canonical(c.Config.Env) === canonical(input.env) && canonical(c.Config.Cmd) === canonical(input.command)
      && !c.Config.Entrypoint?.length && c.HostConfig.NetworkMode === input.network && c.HostConfig.ReadonlyRootfs && !c.HostConfig.Privileged
      && canonical(c.Mounts.map((m: any) => ({ source: m.Source,target: m.Destination,writable: m.RW }))) === canonical(input.mounts), 'native_container', 'Owned runtime configuration mismatch; do not adopt or replace');
    if (!c.State.Running && input.create) { try { await docker.command(['start',c.Id]); } catch {} c = await inspect('container',input.name); }
    ensure(c, 'native_unknown', 'Native runtime is unavailable'); return c;
  }
  async function compose(start: NativeStart, create: boolean) {
    const t = supports(start.task); const ownerId = 'rt-'+fingerprint({ installation: installation.id, task: start.task.id }).slice(0,24);
    const stateRoot = privateDirectory(join(installation.root,'native-state'));
    const parent = join(stateRoot,ownerId); const data = join(parent,'data'); const markerPath = join(parent,'owner.json');
    const marker = { schemaVersion: 1, installationId: installation.id, runtimeOwnerId: ownerId, taskId: start.task.id, source: data };
    if (create) {
      privateDirectory(parent); privateDirectory(data);
      if (!existsSync(markerPath)){if(process.platform==='win32')writeWindowsPrivateFile(markerPath,Buffer.from(JSON.stringify(marker)));else writeFileSync(markerPath,JSON.stringify(marker),{flag:'wx',mode:0o600})}
      if (!existsSync(join(data,'connection-token'))){const token=randomBytes(32).toString('base64url');if(process.platform==='win32')writeWindowsPrivateFile(join(data,'connection-token'),Buffer.from(token));else writeFileSync(join(data,'connection-token'),token,{flag:'wx',mode:0o600})}
    }
    ensure(canonical(JSON.parse(readPrivateFile(markerPath).toString())) === canonical(marker), 'native_state', 'Original native state marker changed');
    const nativeState: NativeStateMount = { installationId: installation.id, runtimeOwnerId: ownerId, taskId: start.task.id, source: data, target: NATIVE_STATE_TARGET, markerPath };
    const internal = await network(ownerId+'-internal',true,create); const egress = await network(ownerId+'-model-egress',false,create);
    const targets = [{ source: start.workspacePath, target:'/workspaces/task' }]; const mounts = await resolveNativeMounts(start,targets);
    const native = await container({ name:ownerId+'-native', image:t.nativeImage, role:'native', owner:ownerId, network:internal.Name, mounts:[{source:data,target:NATIVE_STATE_TARGET,writable:true}], env:nativeEnv, cwd:'/workspaces/task', command:['node','-e','setInterval(()=>{},1000)'], create });
    const workerContainer = await container({ name:ownerId+'-worker', image:t.workerImage, role:'worker', owner:ownerId, network:'none', mounts, env:workerEnv, cwd:'/workspaces/task', command:['node','-e','setInterval(()=>{},1000)'], create });
    // The immutable proxy image must contain the reviewed runtime source, not an arbitrary supplied digest.
    const proxySourceHash = reviewedProxyHash();
    ensure(t.proxy.entrypointSha256 === proxySourceHash, 'native_proxy', 'Proxy entrypoint does not match the reviewed installed source');
    const policyPath = join(parent,'proxy.json');
    const policyKey = 'runtime:proxy-policy:' + ownerId;
    let policyIntent = store.getActionByKey(policyKey);
    if (create && !existsSync(policyPath)) {
      ensure(!policyIntent, 'native_proxy', 'Missing original proxy policy; inspect retained provisioning');
      const identity = createProxyPlaceholder(policyPath);
      policyIntent = store.enqueueAction({key:policyKey,kind:'runtime.proxy-policy',payload:{path:policyPath,...identity}});
    }
    ensure(policyIntent && policyIntent.kind === 'runtime.proxy-policy' && policyIntent.payload.path === policyPath, 'native_proxy', 'Missing owned proxy policy intent');
    const policyFile = statSync(policyPath);
    ensure(policyIntent.payload.dev === policyFile.dev && policyIntent.payload.ino === policyFile.ino, 'native_proxy', 'Proxy policy inode changed');
    const proxy = await container({ name:ownerId+'-proxy', image:t.proxy.image, role:'proxy', owner:ownerId, network:internal.Name, mounts:[{source:policyPath,target:'/etc/software-factory/proxy.json',writable:false}], env:workerEnv, cwd:'/', command:['node',t.proxy.entrypoint,'/etc/software-factory/proxy.json'], alias:'sf-model-proxy', create });
    if (!proxy.NetworkSettings.Networks[egress.Name] && create) { try { await docker.command(['network','connect',egress.Name,proxy.Id]); } catch {} }
    const currentProxy = await inspect('container',proxy.Id);
    const currentNative = await inspect('container',native.Id);
    const currentInternal = await inspect('network',internal.Id);
    const currentEgress = await inspect('network',egress.Id);
    const addresses = proxyTopology(currentInternal,currentEgress,currentNative,currentProxy);
    const policy: ModelProxyPolicy = { schemaVersion:2,kind:'copilot-model-connect',listenPort:3128,nativeRuntimeId:native.Id,internalNetworkId:internal.Id,...addresses,allowedAuthorities:t.proxy.allowedAuthorities };
    if (create) finalizeProxyPolicy(policyPath, policy);
    else ensure(canonical(JSON.parse(readPrivateFile(policyPath).toString())) === canonical(policy), 'native_proxy', 'Original model proxy policy changed');
    store.completeAction(policyIntent.id);
    const proxyControl: NativeModelProxyControl = { policy, async inspect() {
      const current = await inspect('container',proxy.Id); const networkIds = Object.values(current.NetworkSettings.Networks).map((n:any)=>n.NetworkID).sort();
      const nowNative = await inspect('container',native.Id);
      const nowInternal = await inspect('network',internal.Id); const nowEgress = await inspect('network',egress.Id);
      ensure(canonical(proxyTopology(nowInternal,nowEgress,nowNative,current)) === canonical(addresses), 'native_proxy', 'Proxy endpoint identity changed');
      ensure(current.State.Running && current.State.Pid > 0 && current.Image === proxy.Image && canonical(networkIds) === canonical([internal.Id,egress.Id].sort())
        && current.HostConfig.ReadonlyRootfs && !current.HostConfig.Privileged && canonical(current.HostConfig.CapDrop) === canonical(['ALL']) && !current.HostConfig.CapAdd?.length
        && !current.HostConfig.PidMode && !Object.keys(current.HostConfig.PortBindings ?? {}).length && current.Mounts.length === 1 && current.Mounts[0].Source === policyPath && !current.Mounts[0].RW, 'native_proxy', 'Proxy image/topology/restrictions changed');
      let attestation: {code:string;policy:unknown;listeners:number} | undefined;
      for (let attempt=0; attempt<20; attempt++) {
        attestation = JSON.parse(await docker.command(['exec',proxy.Id,'node','-e',`const fs=require('node:fs'),c=require('node:crypto'),p=JSON.parse(fs.readFileSync('/etc/software-factory/proxy.json','utf8'));const addr=p.listenAddress.split('.').map(n=>Number(n).toString(16).padStart(2,'0')).reverse().join('').toUpperCase()+':0C38';const listeners=fs.readFileSync('/proc/net/tcp','utf8').split('\\n').slice(1).map(s=>s.trim().split(/\\s+/)).filter(a=>a[1]===addr&&a[3]==='0A').length;console.log(JSON.stringify({code:c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'),policy:p,listeners}))`,t.proxy.entrypoint]));
        ensure(attestation && attestation.code === proxySourceHash && canonical(attestation.policy) === canonical(policy), 'native_proxy', 'Pinned CONNECT proxy implementation/policy changed');
        if (attestation.listeners === 1) break;
        ensure(attestation.listeners === 0, 'native_proxy', 'Unexpected proxy listeners');
        await new Promise(resolve => setTimeout(resolve,100));
      }
      ensure(attestation?.listeners === 1, 'native_proxy', 'Exact proxy listener unavailable');
      return {runtimeId:proxy.Id,processIdentity:fingerprint({pid:current.State.Pid,started:current.State.StartedAt}),image:t.proxy.image,policySha256:fingerprint(policy),nativeRuntimeId:native.Id,internalNetworkId:internal.Id,egressNetworkId:egress.Id};
    } };
    const gate = createFactoryToolGate({store,broker});
    const launcher = createManagedVsCodeLauncher({ containerId:native.Id,runtimeOwnerId:ownerId,image:t.nativeImage,entrypoint:t.entrypoint,entrypointSha256:t.entrypointSha256,nativeState,nativeStateOwnership:{installationId:installation.id,root:stateRoot},userDataDir:NATIVE_STATE_TARGET+'/user-data',tokenFile:NATIVE_STATE_TARGET+'/connection-token',port:4317,docker,...(docker instanceof ProcessDocker?{dockerExecutable:docker.executable}:{}) });
    const worker = new IsolatedToolWorker({ config:{containerId:workerContainer.Id,image:t.workerImage,runtimeOwnerId:ownerId,nativeContainerId:native.Id,mountTargets:targets},docker,store,gate });
    let boundary!: ReturnType<typeof createIsolatedNativeBoundary>; let verify!: ReturnType<typeof createProfileVerifier>;
    let desktop:Awaited<ReturnType<typeof createDesktopNavigation>>|undefined;
    const closeDesktop=async()=>{const previous=desktop;desktop=undefined;await previous?.close()};
    const prepareDesktop=async(identity:NativeIdentity,assertCurrent:()=>void)=>{
      assertCurrent();await closeDesktop();assertCurrent();
      const next=await createDesktopNavigation({root:installation.root,installationId:installation.id,runtimeOwnerId:ownerId,identity,assertCurrent,launcher});
      try{assertCurrent();desktop=next}catch(error){await next.close();throw error}
    };
    const owner = createVsCodeOwner({journalPath:join(parent,'owner.sqlite'),launcher,compatibility:{protocol:'1.0.0',commits:[t.hostCommit]},workspaceUri:async()=>pathToFileURL('/workspaces/task').href,
      navigation:{get connectionAuthority(){ensure(desktop,'native_navigation','Managed desktop registration is unavailable');return desktop.connectionAuthority},async launch(uri){ensure(desktop,'native_navigation','Managed desktop registration is unavailable');await desktop.launch(uri)}},
      tools:createIsolatedClientTools(gate,worker),
      requireVerifiedProfile:start=>verify.requireVerifiedProfile(start),readinessStarts:async()=>[gate.currentStart()]});
    owner.subscribe(event=>{for(const listener of listeners)listener(event)});
    const protectedPaths = [...options.protectedPaths,markerPath,join(parent,'owner.sqlite'),launcher.controlIntentPath,launcher.pauseReceiptPath,policyPath,join(parent,'navigation.json')];
    boundary = createIsolatedNativeBoundary({owner,gate,worker,launcher,docker,modelProxy:proxyControl,image:t.nativeImage,networks:[internal.Id],protectedPaths});
    verify = createProfileVerifier({profiles:[{id:isolatedProfileId,ownerId:'vscode',providerId:'copilot',image:t.nativeImage,networks:[internal.Id],protectedPaths,boundary,mountTargets:targets,nativeState,nativeStateOwnership:{installationId:installation.id,root:stateRoot}}]});
    const authenticate = async()=>{const ref = config.providerCredentials.find(r=>r.ref===t.credentialRef)!;const expiresIn=ref.expiresAt===undefined?undefined:Math.floor((Date.parse(ref.expiresAt)-Date.now())/1000);ensure(expiresIn===undefined||expiresIn>0,'native_auth','Provider credential expired');await owner.authenticateProvider('copilot',{resource:ref.resource,token:loadCompanionCredential(installation.root,ref).token,...(expiresIn===undefined?{}:{expiresIn}),scopes:ref.scopes})};
    return {owner,worker,gate,launcher,boundary,verify,authenticate,prepareDesktop,closeDesktop};
  }
  type Member = Awaited<ReturnType<typeof compose>>;
  function member(start: NativeStart, create = false): Promise<Member> {
    let value = members.get(start.task.id);
    if (!value) { value = compose(start,create); members.set(start.task.id,value); void value.catch(()=>members.delete(start.task.id)); }
    return value;
  }
  const startFor = (attempt: Attempt): NativeStart => ({idempotencyKey:`native:${attempt.id}`,attemptId:attempt.id,task:store.getTask(attempt.taskId)!.spec,workspacePath:attempt.workspacePath,baseSha:attempt.baseSha,fence:attempt.fence,profileId:attempt.profileId});
  function find(identity:NativeIdentity) { const matches=store.getReservations().filter(r=>canonical(r.attempt.native)===canonical(identity)&&store.getTask(r.attempt.taskId)?.attemptIds.at(-1)===r.attempt.id);ensure(matches.length===1,'native_identity','Expected one current original native identity');return matches[0]!.attempt; }
  const fleetOwner: NativeOwner & { readiness(required: RequiredCapabilities): Promise<import('../contracts/domain.ts').OwnerReadiness> } = {
    async readiness(required) {
      const profiles: string[] = [];
      for (const pending of members.values()) { try { const m = await pending; const start=m.gate.currentStart(); if(canonical(start.task.required)!==canonical(required))continue; profiles.push((await m.verify.requireVerifiedProfile(start)).profileId); } catch {} }
      const ids=[...new Set(profiles)]; const reasons=ids.length?[]:['No current verified isolated native/worker binding for these capabilities'];
      return {ownerId:'vscode',ready:ids.length>0,reasons,supportedProviders:['copilot'],verifiedProfileIds:ids,providers:[{providerId:'copilot',ready:ids.length>0,reasons,verifiedProfileIds:ids},{providerId:'codex',ready:false,reasons:['No verified isolated Codex host implementation'],verifiedProfileIds:[]}],version:'isolated-worker-v2'};
    },
    ensureStarted:async()=>{},
    capabilities:async(_required)=>({ready:false,reasons:['Readiness requires an admitted, inspected per-task isolated runtime'],supportedProviders:['copilot'],verifiedProfileIds:[],version:'isolated-worker-v2'}),
    ensureSession:async start=>(await member(start)).owner.ensureSession(start),
    snapshot:async identity=>(await member(startFor(find(identity)))).owner.snapshot(identity),
    send:async(identity,input,key)=>(await member(startFor(find(identity)))).owner.send(identity,input,key),
    quiesce:async identity=>{const m=await member(startFor(find(identity)));await m.closeDesktop();m.gate.suspend();const [native,worker]=await Promise.all([m.owner.quiesce(identity),m.worker.pause()]);return native==='unknown'||worker==='unknown'?'unknown':native},
    open:async identity=>(await member(startFor(find(identity)))).owner.open(identity),
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
  };
  return { owner:fleetOwner,provisionability,templateReadiness,startFor,member,
    async prepare(start:NativeStart) {ensure(!store.getLifecycle(start.attemptId).state.stopRequested,'native_interrupted','Native attempt was interrupted');ensure(store.getLifecycle(start.attemptId).reservation.status==='confirmed','native_unconfirmed','Confirm actual engine execution before native provisioning');const m=await member(start,true);await m.closeDesktop();ensure(!store.getLifecycle(start.attemptId).state.stopRequested,'native_interrupted','Native attempt was interrupted during provisioning');await m.boundary.prepare(start,start.idempotencyKey,m.authenticate);return m.verify.requireVerifiedProfile(start)},
    async reconcile(start:NativeStart){return (await member(start)).owner.reconcile(start)},
    async close(){for(const promise of members.values()){try{const m=await promise;await m.closeDesktop();await m.owner.close()}catch{}}members.clear()},
  };
}
export type NativeFleet = ReturnType<typeof createNativeFleet>;

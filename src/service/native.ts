import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
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
import { IsolatedToolWorker, isolatedToolDefinitions } from '../owners/worker.ts';
import { createProfileVerifier } from '../isolation/verify.ts';
import { NATIVE_STATE_TARGET, type NativeStateMount } from '../isolation/native-state.ts';
import { resolveNativeMounts } from '../isolation/mounts.ts';
import type { NativeModelProxyControl, ModelProxyPolicy } from '../owners/model-proxy.ts';
import type { RuntimeConfig, IsolatedNativeTemplate } from './config.ts';
import { readVaultSecret, readPrivateFile } from './config.ts';
import { navigationCommits, createNativeNavigation } from '../owners/navigation.ts';
export const isolatedProfileId = 'vscode-copilot-isolated-worker-v2';
const workerEnv = ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8'];
const nativeEnv = ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/opt/software-factory/empty-home','LANG=C.UTF-8','SF_CONTROL_SENTINEL=sf-nonsecret-control-sentinel'];
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
      const credential = config.providerCredentials.find(c => c.ref === template.credentialRef);
      ensure(credential && Date.parse(credential.expiresAt) > Date.now() + 30_000 && readVaultSecret(installation.root, credential.ref).length > 0, 'native_auth', 'Current provider credential is unavailable');
      ensure((navigationCommits as readonly string[]).includes(template.hostCommit), 'native_version', 'Native host commit unsupported');
      for (const image of [template.nativeImage,template.workerImage,template.proxy.image]) { const actual = JSON.parse(await docker.command(['image','inspect',image]))[0]; ensure(actual?.RepoDigests?.includes(image) && actual.Os === 'linux' && actual.Architecture === 'amd64', 'native_image', 'Pinned native/worker/proxy image is unavailable'); }
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
  async function container(input: { name: string; image: string; owner: string; network: string; mounts: { source: string; target: string; writable: boolean }[]; env: string[]; cwd: string; command: string[]; create: boolean; alias?: string }) {
    const image = JSON.parse(await docker.command(['image','inspect',input.image]))[0];
    ensure(image.RepoDigests?.includes(input.image) && !image.Config.Entrypoint?.length && canonical(image.Config.Env ?? []) === canonical(input.env), 'native_image', 'Pinned image must declare exact minimal environment and no implicit entrypoint');
    const uid = process.getuid!(); const gid = process.getgid!(); ensure(uid > 0, 'native_user', 'Native runtimes require a nonroot installation');
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
      if (!existsSync(markerPath)) writeFileSync(markerPath,JSON.stringify(marker),{ flag:'wx',mode:0o600 });
      if (!existsSync(join(data,'connection-token'))) writeFileSync(join(data,'connection-token'),randomBytes(32).toString('base64url'),{ flag:'wx',mode:0o600 });
    }
    ensure(canonical(JSON.parse(readFileSync(markerPath,'utf8'))) === canonical(marker), 'native_state', 'Original native state marker changed');
    const nativeState: NativeStateMount = { installationId: installation.id, runtimeOwnerId: ownerId, taskId: start.task.id, source: data, target: NATIVE_STATE_TARGET, markerPath };
    const internal = await network(ownerId+'-internal',true,create); const egress = await network(ownerId+'-model-egress',false,create);
    const targets = [{ source: start.workspacePath, target:'/workspaces/task' }]; const mounts = await resolveNativeMounts(start,targets);
    const native = await container({ name:ownerId+'-native', image:t.nativeImage, owner:ownerId, network:internal.Name, mounts:[{source:data,target:NATIVE_STATE_TARGET,writable:true}], env:nativeEnv, cwd:'/workspaces/task', command:['node','-e','setInterval(()=>{},1000)'], create });
    const workerContainer = await container({ name:ownerId+'-worker', image:t.workerImage, owner:ownerId, network:'none', mounts, env:workerEnv, cwd:'/workspaces/task', command:['node','-e','setInterval(()=>{},1000)'], create });
    const policy: ModelProxyPolicy = { schemaVersion:1,kind:'copilot-model-connect',listenPort:3128,nativeRuntimeId:native.Id,internalNetworkId:internal.Id,allowedAuthorities:t.proxy.allowedAuthorities };
    const policyPath = join(parent,'proxy.json');
    if (create && !existsSync(policyPath)) writeFileSync(policyPath,JSON.stringify(policy),{flag:'wx',mode:0o600});
    ensure(canonical(JSON.parse(readFileSync(policyPath,'utf8'))) === canonical(policy), 'native_proxy', 'Original model proxy policy changed');
    const proxy = await container({ name:ownerId+'-proxy', image:t.proxy.image, owner:ownerId, network:internal.Name, mounts:[{source:policyPath,target:'/etc/software-factory/proxy.json',writable:false}], env:workerEnv, cwd:'/', command:['node',t.proxy.entrypoint,'/etc/software-factory/proxy.json'], alias:'sf-model-proxy', create });
    if (!proxy.NetworkSettings.Networks[egress.Name] && create) { try { await docker.command(['network','connect',egress.Name,proxy.Id]); } catch {} }
    const proxyControl: NativeModelProxyControl = { policy, async inspect() {
      const current = await inspect('container',proxy.Id); const networkIds = Object.values(current.NetworkSettings.Networks).map((n:any)=>n.NetworkID).sort();
      ensure(current.State.Running && current.State.Pid > 0 && current.Image === proxy.Image && canonical(networkIds) === canonical([internal.Id,egress.Id].sort())
        && current.HostConfig.ReadonlyRootfs && !current.HostConfig.Privileged && canonical(current.HostConfig.CapDrop) === canonical(['ALL']) && !current.HostConfig.CapAdd?.length
        && !current.HostConfig.PidMode && !Object.keys(current.HostConfig.PortBindings ?? {}).length && current.Mounts.length === 1 && current.Mounts[0].Source === policyPath && !current.Mounts[0].RW, 'native_proxy', 'Proxy image/topology/restrictions changed');
      const attestation = JSON.parse(await docker.command(['exec',proxy.Id,'node','-e',`const fs=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify({code:c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'),policy:JSON.parse(fs.readFileSync('/etc/software-factory/proxy.json','utf8'))}))`,t.proxy.entrypoint]));
      ensure(attestation.code === t.proxy.entrypointSha256 && canonical(attestation.policy) === canonical(policy), 'native_proxy', 'Pinned CONNECT proxy implementation/policy changed');
      return {runtimeId:proxy.Id,processIdentity:fingerprint({pid:current.State.Pid,started:current.State.StartedAt}),image:t.proxy.image,policySha256:fingerprint(policy),nativeRuntimeId:native.Id,internalNetworkId:internal.Id,egressNetworkId:egress.Id};
    } };
    const gate = createFactoryToolGate({store,broker});
    const launcher = createManagedVsCodeLauncher({ containerId:native.Id,runtimeOwnerId:ownerId,image:t.nativeImage,entrypoint:t.entrypoint,entrypointSha256:t.entrypointSha256,nativeState,nativeStateOwnership:{installationId:installation.id,root:stateRoot},userDataDir:NATIVE_STATE_TARGET+'/user-data',tokenFile:NATIVE_STATE_TARGET+'/connection-token',port:4317,docker,...(docker instanceof ProcessDocker?{dockerExecutable:docker.executable}:{}) });
    const worker = new IsolatedToolWorker({ config:{containerId:workerContainer.Id,image:t.workerImage,runtimeOwnerId:ownerId,nativeContainerId:native.Id,mountTargets:targets},docker,store,gate });
    let boundary!: ReturnType<typeof createIsolatedNativeBoundary>; let verify!: ReturnType<typeof createProfileVerifier>;
    const navigation = () => {
      const value=JSON.parse(readPrivateFile(join(parent,'navigation.json')).toString());
      ensure(value.schemaVersion===1&&value.runtimeOwnerId===ownerId&&value.containerId===native.Id&&typeof value.connectionAuthority==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value.connectionAuthority)
        &&Object.keys(value).every(key=>['schemaVersion','runtimeOwnerId','containerId','connectionAuthority','cliPath'].includes(key))&&(value.cliPath===undefined||typeof value.cliPath==='string'&&value.cliPath.startsWith('/')), 'native_navigation', 'Register this exact managed host through the owning desktop bridge before opening it');
      return value as {connectionAuthority:string;cliPath?:string};
    };
    const owner = createVsCodeOwner({journalPath:join(parent,'owner.sqlite'),launcher,compatibility:{protocol:'1.0.0',commits:[t.hostCommit]},workspaceUri:async()=>pathToFileURL('/workspaces/task').href,
      navigation:{get connectionAuthority(){return navigation().connectionAuthority},async launch(uri){await createNativeNavigation(navigation().cliPath).launch(uri)}},
      tools:{definitions:[...gate.definitions,...isolatedToolDefinitions],invoke:(identity,callId,name,input)=>name==='sf_factory_operation'?gate.invoke(identity,callId,name,input):worker.invoke(identity,callId,name,input)},
      requireVerifiedProfile:start=>verify.requireVerifiedProfile(start),readinessStarts:async()=>[gate.currentStart()]});
    owner.subscribe(event=>{for(const listener of listeners)listener(event)});
    const protectedPaths = [...options.protectedPaths,markerPath,join(parent,'owner.sqlite'),launcher.controlIntentPath,launcher.pauseReceiptPath,policyPath,join(parent,'navigation.json')];
    boundary = createIsolatedNativeBoundary({owner,gate,worker,launcher,docker,modelProxy:proxyControl,image:t.nativeImage,networks:[internal.Id],protectedPaths});
    verify = createProfileVerifier({profiles:[{id:isolatedProfileId,ownerId:'vscode',providerId:'copilot',image:t.nativeImage,networks:[internal.Id],protectedPaths,boundary,mountTargets:targets,nativeState,nativeStateOwnership:{installationId:installation.id,root:stateRoot}}]});
    const authenticate = async()=>{const ref = config.providerCredentials.find(r=>r.ref===t.credentialRef)!;const expiresIn=Math.floor((Date.parse(ref.expiresAt)-Date.now())/1000);ensure(expiresIn>0,'native_auth','Provider credential expired');await owner.authenticateProvider('copilot',{resource:ref.resource,token:readVaultSecret(installation.root,ref.ref).toString(),expiresIn,scopes:ref.scopes})};
    return {owner,worker,gate,launcher,boundary,verify,authenticate};
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
    quiesce:async identity=>{const m=await member(startFor(find(identity)));m.gate.suspend();const [native,worker]=await Promise.all([m.owner.quiesce(identity),m.worker.pause()]);return native==='unknown'||worker==='unknown'?'unknown':native},
    open:async identity=>(await member(startFor(find(identity)))).owner.open(identity),
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
  };
  return { owner:fleetOwner,provisionability,templateReadiness,startFor,member,
    async prepare(start:NativeStart) {ensure(!store.getLifecycle(start.attemptId).state.stopRequested,'native_interrupted','Native attempt was interrupted');ensure(store.getLifecycle(start.attemptId).reservation.status==='confirmed','native_unconfirmed','Confirm actual engine execution before native provisioning');const m=await member(start,true);ensure(!store.getLifecycle(start.attemptId).state.stopRequested,'native_interrupted','Native attempt was interrupted during provisioning');await m.boundary.prepare(start,start.idempotencyKey,m.authenticate);return m.verify.requireVerifiedProfile(start)},
    async reconcile(start:NativeStart){return (await member(start)).owner.reconcile(start)},
    async close(){for(const promise of members.values()){try{await (await promise).owner.close()}catch{}}members.clear()},
  };
}
export type NativeFleet = ReturnType<typeof createNativeFleet>;

import { imageReleaseMatches } from '../release/provenance.ts';
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Attempt, NativeIdentity, NativeStart, OwnerEvent, RequiredCapabilities, TaskSpec } from '../contracts/domain.ts';
import type { NativeOwner } from '../contracts/owner.ts';
import type { Installation } from '../kestra/deployment.ts';
import { dockerBind, ProcessDocker } from '../kestra/deployment.ts';
import { privateDirectoryAsync } from '../kestra/executions.ts';
import type { RecipeExecutionProfile } from '../recipes/registry.ts';
import type { FactoryStore } from '../storage/store.ts';
import type { AttemptBroker } from '../broker/operations.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import { createFactoryToolGate } from '../owners/tools.ts';
import { prepareOwnerJournal } from '../owners/journal.ts';
import { createVsCodeOwner } from '../owners/vscode.ts';
import { createManagedVsCodeLauncher } from '../owners/managed.ts';
import { createIsolatedNativeBoundary, isolatedToolAllowlist } from '../owners/isolated.ts';
import { IsolatedToolWorker, createIsolatedClientTools } from '../owners/worker.ts';
import { createProfileVerifier } from '../isolation/verify.ts';
import { NATIVE_STATE_TARGET, verifyNativeStateMount, type NativeStateMount } from '../isolation/native-state.ts';
import { resolveNativeMounts } from '../isolation/mounts.ts';
import type { NativeModelProxyControl, ModelProxyPolicy } from '../owners/model-proxy.ts';
import { imageMatches } from '../isolation/image.ts';
import { expectedImageBuild } from '../install/images.ts';
import { proxyTopology } from './proxy-topology.ts';
import { createProxyPlaceholderAsync, finalizeProxyPolicyAsync } from './proxy-policy.ts';
import type { RuntimeConfig, IsolatedNativeTemplate } from './config.ts';
import { readPrivateFileAsync } from './config.ts';
import { refreshCompanionCredential } from '../install/companion-launch.ts';
import { loadCompanionCredentialAsync } from '../install/companion-auth.ts';
import { navigationCommits } from '../owners/navigation.ts';
import { humanActionObserved } from '../owners/human-reconcile.ts';
import { createDesktopNavigation } from '../owners/desktop.ts';
import { beginNativeMutation } from './native-effects.ts';
import type { OutboxAction } from '../storage/store.ts';
import { inspectNativeInventory } from './native-inventory.ts';
import { inspectRecordedOwnerReceipt } from '../owners/maintenance-receipt.ts';
export const isolatedProfileId = 'vscode-copilot-isolated-worker-v2';
const workerEnv = ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8'];
const nativeEnv = ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/opt/software-factory/empty-home','LANG=C.UTF-8','SF_CONTROL_SENTINEL=sf-nonsecret-control-sentinel'];
const curatedModelAuthorities = new Set(['api.github.com:443','api.githubcopilot.com:443','copilot-proxy.githubusercontent.com:443']);
function reviewedProxyHash() {
  const source = new URL(import.meta.url.endsWith('.ts') ? '../../runtime/model-proxy/connect.cjs' : '../runtime/model-proxy/connect.cjs', import.meta.url);
  return createHash('sha256').update(readFileSync(source)).digest('hex');
}
/** Provisioning intention only. Actual isolation remains a post-reservation dispatch gate. */
export function nativeExecutionProfile(template: IsolatedNativeTemplate, sourceFingerprint: string, reviewedProxySha256: string,
  availability: { reasons: string[]; credentialCurrent: boolean; [key: string]: unknown }): RecipeExecutionProfile {
  return { available: availability.reasons.length === 0 && availability.credentialCurrent, isolatedProfileId, kind: template.kind, hostCommit: template.hostCommit,
    nativeImage: template.nativeImage, workerImage: template.workerImage,
    entrypoint: template.entrypoint, entrypointSha256: template.entrypointSha256,
    pristineDirectory: template.pristineDirectory, emptyHome: template.emptyHome,
    proxy: { ...template.proxy, allowedAuthorities: [...template.proxy.allowedAuthorities].sort(), reviewedProxySha256,
      policyVersion: 2, curatedAuthorities: [...curatedModelAuthorities].sort() },
    sourceFingerprint, capabilityPolicy: { toolkitVersion: '2', tools: ['native-files','native-terminal'],
      excludedTools: ['builtin:*','mcp:*'], externalNetwork: false, credentials: false, skills: false,
      allowlistHash: fingerprint(isolatedToolAllowlist.toString()) }, availability: structuredClone(availability) };
}
export function createNativeFleet(options: { installation: Installation; config: RuntimeConfig; store: FactoryStore; broker: AttemptBroker; protectedPaths: string[]; maintenance?:()=>boolean }) {
  const { installation, config, store, broker } = options; const docker = installation.docker;
  const listeners = new Set<(event: OwnerEvent) => void>();
  const members = new Map<string, Promise<Member>>();
  const template = config.native[0] ? structuredClone(config.native[0]) : undefined;
  const buildSourceFingerprint = expectedImageBuild().sourceFingerprint;
  const reviewedProxySha256 = reviewedProxyHash();
  let availabilityReasons = ['Native template availability has not been checked'];
  function executionProfile(): RecipeExecutionProfile | undefined {
    if (!template) return undefined;
    const credential = config.providerCredentials.find(c => c.ref === template.credentialRef);
    return nativeExecutionProfile(template, buildSourceFingerprint, reviewedProxySha256, {
      reasons: availabilityReasons, credentialConfigured: !!credential,
      credentialCurrent: !!credential && (credential.expiresAt === undefined || Date.parse(credential.expiresAt) > Date.now() + 30_000),
      credentialAuthority: credential ? { providerId: credential.providerId, resource: credential.resource, scopes: [...credential.scopes].sort() } : null,
    });
  }
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
      ensure(credential && (credential.expiresAt === undefined || Date.parse(credential.expiresAt) > Date.now() + 30_000) && (await loadCompanionCredentialAsync(installation.root,credential)).token.length > 0, 'native_auth', 'Current provider credential is unavailable');
      ensure((navigationCommits as readonly string[]).includes(template.hostCommit), 'native_version', 'Native host commit unsupported');
      for (const [role,image] of [['native',template.nativeImage],['worker',template.workerImage],['proxy',template.proxy.image]] as const) {
        const actual = JSON.parse(await docker.command(['image','inspect',image]))[0];
        ensure(imageMatches(image,actual) && actual.Os === 'linux' && actual.Architecture === 'amd64' && (!image.startsWith('sha256:') || imageReleaseMatches(actual.Config?.Labels,expectedImageBuild()) && actual.Config?.Labels?.['sf.installation'] === installation.id && actual.Config?.Labels?.['sf.build'] === expectedImageBuild().sourceFingerprint && actual.Config?.Labels?.['sf.role'] === role), 'native_image', 'Pinned native/worker/proxy image is unavailable or its owned build does not match');
      }
      availabilityReasons = [];
    } catch (error) { availabilityReasons = [error instanceof Error ? error.message : 'Native provisioning unavailable']; }
    return [...availabilityReasons];
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
    let n = await inspect('network',name);let intent:OutboxAction|undefined;
    if (!n && create) {intent=beginNativeMutation(store,'network-create',name);await docker.command(['network','create',...(internal ? ['--internal'] : []),'--driver','bridge','--label','sf.installation='+installation.id,name]);n = await inspect('network',name);}
    ensure(n?.Name === name && n.Internal === internal && n.Driver === 'bridge' && n.Labels?.['sf.installation'] === installation.id, 'native_network', 'Exact owned runtime network unavailable');
    if(intent){const receipt=store.enqueueAction({key:'runtime:network-owner:'+name,kind:'runtime.network_owner',payload:{installationId:installation.id,name,networkId:n.Id}});store.completeAction(receipt.id);store.completeAction(intent.id)}return n;
  }
  async function container(input: { name: string; image: string; role: 'native' | 'worker' | 'proxy'; owner: string; network: string; mounts: { source: string; target: string; writable: boolean }[]; env: string[]; cwd: string; command: string[]; create: boolean; alias?: string }) {
    const image = JSON.parse(await docker.command(['image','inspect',input.image]))[0];
    ensure(imageMatches(input.image,image) && (!input.image.startsWith('sha256:') || imageReleaseMatches(image.Config?.Labels,expectedImageBuild()) && image.Config?.Labels?.['sf.installation'] === installation.id && image.Config?.Labels?.['sf.build'] === expectedImageBuild().sourceFingerprint && image.Config?.Labels?.['sf.role'] === input.role) && !image.Config.Entrypoint?.length && canonical(image.Config.Env ?? []) === canonical(input.env), 'native_image', 'Pinned image must declare exact minimal environment and no implicit entrypoint');
    const uid = process.platform==='win32'?1000:process.getuid!(); const gid = process.platform==='win32'?1000:process.getgid!(); ensure(uid > 0, 'native_user', 'Native runtimes require a nonroot installation');
    let c = await inspect('container',input.name);let createIntent:OutboxAction|undefined;let creation:OutboxAction|undefined;
    if (!c && input.create) {
      createIntent=beginNativeMutation(store,'container-create',input.name);
      const claim=store.claimAction({ key: 'runtime:container:'+input.name, kind: 'runtime.container', payload: { name: input.name, image: input.image, owner: input.owner } });ensure(claim.fresh,'native_unknown','Original container creation requires recovery');creation=claim.action;
      await docker.command(['create','--name',input.name,'--pull','never','--platform','linux/amd64','--user',`${uid}:${gid}`,'--workdir',input.cwd,
        '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','2g','--cpus','2','--restart','no',
        '--tmpfs',`/tmp:rw,nosuid,nodev,noexec,uid=${uid},gid=${gid},mode=1777`,'--network',input.network,...(input.alias ? ['--network-alias',input.alias] : []),
        '--label','sf.installation='+installation.id,'--label','sf.runtime-owner='+input.owner,
        ...input.mounts.flatMap(m => ['--mount',dockerBind(m.source,m.target,!m.writable)]),input.image,...input.command]);
      c = await inspect('container',input.name);
    }
    ensure(c?.Image === image.Id && c.Config.Image === input.image && c.Config.Labels?.['sf.runtime-owner'] === input.owner && c.Config.User === `${uid}:${gid}`
      && c.Config.WorkingDir === input.cwd && canonical(c.Config.Env) === canonical(input.env) && canonical(c.Config.Cmd) === canonical(input.command)
      && !c.Config.Entrypoint?.length && c.HostConfig.NetworkMode === input.network && c.HostConfig.ReadonlyRootfs && !c.HostConfig.Privileged && c.HostConfig.RestartPolicy?.Name==='no' && c.HostConfig.AutoRemove===false
      && canonical(c.Mounts.map((m: any) => ({ source: m.Source,target: m.Destination,writable: m.RW }))) === canonical(input.mounts), 'native_container', 'Owned runtime configuration mismatch; do not adopt or replace');
    if(createIntent&&creation){const receipt=store.enqueueAction({key:'runtime:container-owner:'+input.name,kind:'runtime.container_owner',payload:{installationId:installation.id,name:input.name,containerId:c.Id,owner:input.owner,image:input.image}});store.completeAction(receipt.id);store.completeAction(creation.id);store.completeAction(createIntent.id)}
    if (!c.State.Running && input.create) {
      const id=c.Id;const shape=canonical({Image:c.Image,Config:c.Config,HostConfig:c.HostConfig,Mounts:c.Mounts});const intent=beginNativeMutation(store,'container-start',id);
      await docker.command(['start',id]);c=await inspect('container',input.name);
      ensure(c?.Id===id&&c.State?.Running===true&&c.State.Paused===false&&c.State.Pid>0&&typeof c.State.StartedAt==='string'&&c.State.StartedAt&&canonical({Image:c.Image,Config:c.Config,HostConfig:c.HostConfig,Mounts:c.Mounts})===shape,'native_unknown','Native container start is not confirmed');
      const receipt=store.enqueueAction({key:'runtime:container-generation:'+id+':'+c.State.StartedAt,kind:'runtime.container_generation',payload:{installationId:installation.id,containerId:id,startedAt:c.State.StartedAt,owner:input.owner}});store.completeAction(receipt.id);store.completeAction(intent.id);
    }
    ensure(c, 'native_unknown', 'Native runtime is unavailable'); return c;
  }
  async function compose(start: NativeStart, create: boolean) {
    const t = supports(start.task); const ownerId = 'rt-'+fingerprint({ installation: installation.id, task: start.task.id }).slice(0,24);
    const stateRoot = join(installation.root,'native-state');if(create)await privateDirectoryAsync(stateRoot);
    const parent = join(stateRoot,ownerId); const data = join(parent,'data'); const markerPath = join(parent,'owner.json');
    const marker = { schemaVersion: 1, installationId: installation.id, runtimeOwnerId: ownerId, taskId: start.task.id, source: data };
    if (create) {
      await privateDirectoryAsync(parent); await privateDirectoryAsync(data);
      if (!existsSync(markerPath)){if(process.platform==='win32')await writeWindowsPrivateFileAsync(markerPath,Buffer.from(JSON.stringify(marker)));else writeFileSync(markerPath,JSON.stringify(marker),{flag:'wx',mode:0o600})}
      if (!existsSync(join(data,'connection-token'))){const token=randomBytes(32).toString('base64url');if(process.platform==='win32')await writeWindowsPrivateFileAsync(join(data,'connection-token'),Buffer.from(token));else writeFileSync(join(data,'connection-token'),token,{flag:'wx',mode:0o600})}
    }
    ensure(canonical(JSON.parse((await readPrivateFileAsync(markerPath)).toString())) === canonical(marker), 'native_state', 'Original native state marker changed');
    const nativeState: NativeStateMount = { installationId: installation.id, runtimeOwnerId: ownerId, taskId: start.task.id, source: data, target: NATIVE_STATE_TARGET, markerPath };
    await verifyNativeStateMount(nativeState,start.task.id,{installationId:installation.id,root:stateRoot});
    const internal = await network(ownerId+'-internal',true,create); const egress = await network(ownerId+'-model-egress',false,create);
    const targets = [{ source: start.workspacePath, target:'/workspaces/task' }]; const mounts = await resolveNativeMounts(start,targets);
    const native = await container({ name:ownerId+'-native', image:t.nativeImage, role:'native', owner:ownerId, network:internal.Name, mounts:[{source:data,target:NATIVE_STATE_TARGET,writable:true}], env:nativeEnv, cwd:'/workspaces/task', command:['node','-e','setInterval(()=>{},1000)'], create });
    const workerContainer = await container({ name:ownerId+'-worker', image:t.workerImage, role:'worker', owner:ownerId, network:'none', mounts, env:workerEnv, cwd:'/workspaces/task', command:['node','-e','setInterval(()=>{},1000)'], create });
    // The immutable proxy image must contain the reviewed runtime source, not an arbitrary supplied digest.
    const proxySourceHash = reviewedProxyHash();
    ensure(t.proxy.entrypointSha256 === proxySourceHash, 'native_proxy', 'Proxy entrypoint does not match the reviewed installed source');
    const policyPath = join(parent,'proxy.json');
    const policyKey = 'runtime:proxy-policy:' + ownerId;
    let policyIntent = store.getActionByKey(policyKey);let createdPolicy=false;
    if (create && !existsSync(policyPath)) {
      ensure(!policyIntent, 'native_proxy', 'Missing original proxy policy; inspect retained provisioning');
      const identity = await createProxyPlaceholderAsync(policyPath);
      policyIntent = store.enqueueAction({key:policyKey,kind:'runtime.proxy-policy',payload:{path:policyPath,...identity}});
      createdPolicy=true;
    }
    ensure(policyIntent && policyIntent.kind === 'runtime.proxy-policy' && policyIntent.payload.path === policyPath, 'native_proxy', 'Missing owned proxy policy intent');
    ensure(policyIntent.completedAt||createdPolicy,'native_proxy','Original proxy policy write is unresolved');
    const policyFile = statSync(policyPath);
    ensure(policyIntent.payload.dev === policyFile.dev && policyIntent.payload.ino === policyFile.ino, 'native_proxy', 'Proxy policy inode changed');
    const proxy = await container({ name:ownerId+'-proxy', image:t.proxy.image, role:'proxy', owner:ownerId, network:internal.Name, mounts:[{source:policyPath,target:'/etc/software-factory/proxy.json',writable:false}], env:workerEnv, cwd:'/', command:['node',t.proxy.entrypoint,'/etc/software-factory/proxy.json'], alias:'sf-model-proxy', create });
    let connectionIntent:OutboxAction|undefined;
    if (!proxy.NetworkSettings.Networks[egress.Name] && create) {connectionIntent=beginNativeMutation(store,'network-connect',proxy.Id);await docker.command(['network','connect',egress.Name,proxy.Id]);}
    const currentProxy = await inspect('container',proxy.Id);
    const currentNative = await inspect('container',native.Id);
    const currentInternal = await inspect('network',internal.Id);
    const currentEgress = await inspect('network',egress.Id);
    const addresses = proxyTopology(currentInternal,currentEgress,currentNative,currentProxy);
    if(connectionIntent){const receipt=store.enqueueAction({key:'runtime:network-connection:'+ownerId,kind:'runtime.network_connection',payload:{installationId:installation.id,owner:ownerId,containerId:proxy.Id,networkId:egress.Id}});store.completeAction(receipt.id);store.completeAction(connectionIntent.id)}
    const policy: ModelProxyPolicy = { schemaVersion:2,kind:'copilot-model-connect',listenPort:3128,nativeRuntimeId:native.Id,internalNetworkId:internal.Id,...addresses,allowedAuthorities:t.proxy.allowedAuthorities };
    if (create) await finalizeProxyPolicyAsync(policyPath, policy);
    else ensure(canonical(JSON.parse((await readPrivateFileAsync(policyPath)).toString())) === canonical(policy), 'native_proxy', 'Original model proxy policy changed');
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
    const launcher = createManagedVsCodeLauncher({ containerId:native.Id,runtimeOwnerId:ownerId,image:t.nativeImage,entrypoint:t.entrypoint,entrypointSha256:t.entrypointSha256,nativeState,nativeStateOwnership:{installationId:installation.id,root:stateRoot},userDataDir:NATIVE_STATE_TARGET+'/user-data',tokenFile:NATIVE_STATE_TARGET+'/connection-token',port:4317,docker,async recordGeneration(containerId,startedAt){const receipt=store.enqueueAction({key:'runtime:container-generation:'+containerId+':'+startedAt,kind:'runtime.container_generation',payload:{installationId:installation.id,containerId,startedAt,owner:ownerId}});store.completeAction(receipt.id)},...(docker instanceof ProcessDocker?{dockerExecutable:docker.executable}:{}) });
    const worker = new IsolatedToolWorker({ config:{containerId:workerContainer.Id,image:t.workerImage,runtimeOwnerId:ownerId,nativeContainerId:native.Id,mountTargets:targets},docker,store,gate });
    let boundary!: ReturnType<typeof createIsolatedNativeBoundary>; let verify!: ReturnType<typeof createProfileVerifier>;
    let desktop:Awaited<ReturnType<typeof createDesktopNavigation>>|undefined;
    const assertNoHumanEffect=()=>ensure(!store.pendingActions().some(a=>a.kind==='human.relay'&&a.payload.attemptId===start.attemptId),'human_effect_unknown','Human native action outcome is unresolved; retain original control and history');
    let desktopClosing:Promise<void>=Promise.resolve();
    const closeDesktop=async()=>{const previous=desktop;desktop=undefined;if(previous)desktopClosing=desktopClosing.then(()=>previous.close());await desktopClosing};
    const prepareDesktop=async(identity:NativeIdentity,assertCurrent:()=>void)=>{
      assertCurrent();await closeDesktop();assertNoHumanEffect();assertCurrent();
      const next=await createDesktopNavigation({root:installation.root,installationId:installation.id,runtimeOwnerId:ownerId,identity,assertCurrent,beforeHumanAction(action){assertCurrent();const key='human-relay:'+start.attemptId+':'+randomUUID();const proof=action.type==='chat/turnStarted'&&typeof action.turnId==='string'&&action.message&&typeof action.message==='object'?{type:action.type,turnId:action.turnId,messageHash:fingerprint(action.message)}:{type:typeof action.type==='string'?action.type:'unknown'};store.enqueueAction({key,kind:'human.relay',payload:{attemptId:start.attemptId,repositoryId:start.task.repositoryId,proof}});return key},humanActionAcknowledged(key){const action=store.getActionByKey(key);ensure(action&&action.kind==='human.relay'&&action.payload.attemptId===start.attemptId,'human_effect_unknown','Human action receipt does not match');store.completeAction(action.id)},launcher});
      try{assertCurrent();desktop=next}catch(error){await next.close();throw error}
    };
    const journalPath=join(parent,'owner.sqlite');const journalProtection=await prepareOwnerJournal(journalPath);
    const owner = createVsCodeOwner({journalPath,...(journalProtection?{journalProtection}:{}),launcher,compatibility:{protocol:'1.0.0',commits:[t.hostCommit]},workspaceUri:async()=>pathToFileURL('/workspaces/task').href,
      navigation:{get connectionAuthority(){ensure(desktop,'native_navigation','Managed desktop registration is unavailable');return desktop.connectionAuthority},async launch(uri){ensure(desktop,'native_navigation','Managed desktop registration is unavailable');await desktop.launch(uri)}},
      tools:createIsolatedClientTools(gate,worker),
      requireVerifiedProfile:start=>verify.requireVerifiedProfile(start),readinessStarts:async()=>[gate.currentStart()]});
    owner.subscribe(event=>{for(const listener of listeners)listener(event)});
    const protectedPaths = [...options.protectedPaths,markerPath,join(parent,'owner.sqlite'),launcher.controlIntentPath,launcher.pauseReceiptPath,policyPath,join(parent,'navigation.json')];
    boundary = createIsolatedNativeBoundary({owner,gate,worker,launcher,docker,modelProxy:proxyControl,image:t.nativeImage,networks:[internal.Id],protectedPaths});
    verify = createProfileVerifier({profiles:[{id:isolatedProfileId,ownerId:'vscode',providerId:'copilot',image:t.nativeImage,networks:[internal.Id],protectedPaths,boundary,mountTargets:targets,nativeState,nativeStateOwnership:{installationId:installation.id,root:stateRoot}}]});
    const authenticate = async()=>{const ref = config.providerCredentials.find(r=>r.ref===t.credentialRef)!;const startup=JSON.parse((await readPrivateFileAsync(join(installation.root,'startup.json'))).toString());ensure(startup.installationId===installation.id&&typeof startup.codeExecutable==='string'&&startup.requestDir===join(installation.root,'auth-request'),'native_auth','Private companion configuration unavailable');await refreshCompanionCredential({root:installation.root,requestDir:startup.requestDir,installationId:installation.id,codeExecutable:startup.codeExecutable});const expiresIn=ref.expiresAt===undefined?undefined:Math.floor((Date.parse(ref.expiresAt)-Date.now())/1000);ensure(expiresIn===undefined||expiresIn>0,'native_auth','Provider credential expired');await owner.authenticateProvider('copilot',{resource:ref.resource,token:(await loadCompanionCredentialAsync(installation.root,ref)).token,...(expiresIn===undefined?{}:{expiresIn}),scopes:ref.scopes})};
    const reconcileHumanEffects=async(identity:NativeIdentity,connectedOnly=false)=>{const attempts=new Set(store.getReservations().filter(r=>canonical(r.attempt.native)===canonical(identity)).map(r=>r.attempt.id));const actions=store.pendingActions().filter(a=>a.kind==='human.relay'&&attempts.has(String(a.payload.attemptId)));if(!actions.length)return;const chat=connectedOnly?await owner.readConnectedChat(identity):await owner.chat(identity);for(const action of actions){if(humanActionObserved(action.payload.proof as Record<string,unknown>,chat))store.completeAction(action.id)}};
    return {owner,worker,gate,launcher,boundary,verify,authenticate,prepareDesktop,closeDesktop,reconcileHumanEffects,assertNoHumanEffect};
  }
  type Member = Awaited<ReturnType<typeof compose>>;
  function member(start: NativeStart, create = false): Promise<Member> {
    let value = members.get(start.task.id);
    if (!value) { value = compose(start,create).then(member=>{if(options.maintenance?.())member.owner.forbidMaintenanceStart();return member}); members.set(start.task.id,value); void value.catch(()=>members.delete(start.task.id)); }
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
    quiesce:async identity=>{
      const unresolved=()=>store.pendingActions().some(a=>['runtime.native_mutation','runtime.container','worker.execute','worker.pause','worker.resume','worker.maintenance_stop','human.relay','lifecycle.human_open'].includes(a.kind));
      if(unresolved())return 'unknown';
      let m:Member;
      if(options.maintenance?.()){
        try {
          const matches=store.getReservations().filter(r=>canonical(r.attempt.native)===canonical(identity));const tasks=[...new Set(matches.map(r=>r.attempt.taskId))];ensure(tasks.length===1,'native_identity','Original native identity is ambiguous');const attempt=matches.at(-1)!.attempt;
          ensure(matches.every(r=>r.attempt.workspacePath===attempt.workspacePath&&r.attempt.baseSha===attempt.baseSha),'native_identity','Original native workspace changed');
          const t=supports(store.getTask(attempt.taskId)!.spec);const items=await inspectNativeInventory({id:installation.id,root:installation.root,docker,store,images:{native:t.nativeImage,worker:t.workerImage,proxy:t.proxy.image}});const item=items.find(value=>value.taskId===attempt.taskId);ensure(item,'native_identity','Original native runtime unavailable');
          const native=item.containers.find(c=>c.role==='native')!,worker=item.containers.find(c=>c.role==='worker')!;
          const receipt=await inspectRecordedOwnerReceipt({directory:join(installation.root,'native-state',item.ownerId),identity,taskId:attempt.taskId,workspacePath:attempt.workspacePath,baseSha:attempt.baseSha,container:native,entrypoint:t.entrypoint});
          const workerReceipt=worker.startedAt?store.getActionByKey((worker.frozen?'worker:pause:':'worker:maintenance-stop:')+worker.id+':'+worker.startedAt):undefined;
          if(receipt!=='unknown'&&workerReceipt?.completedAt&&((worker.frozen&&workerReceipt.kind==='worker.pause')||(worker.stopped&&workerReceipt.kind==='worker.maintenance_stop'))&&!unresolved())return receipt;
          const existing=members.get(attempt.taskId);if(!existing)return 'unknown';m=await existing;m.owner.forbidMaintenanceStart();m.worker.closeAdmission();
        }catch{return 'unknown'}
      } else {m=await member(startFor(find(identity)));m.gate.suspend()}
      let closed=true;try{await m.closeDesktop();await m.reconcileHumanEffects(identity,!!options.maintenance?.())}catch{closed=false}
      const [native,worker]=await Promise.all([m.owner.quiesce(identity),options.maintenance?.()?m.worker.quiesceForMaintenance():m.worker.pause()]);try{m.assertNoHumanEffect()}catch{closed=false}return !closed||unresolved()||native==='unknown'||worker==='unknown'?'unknown':native;
    },
    open:async identity=>(await member(startFor(find(identity)))).owner.open(identity),
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
  };
  return { owner:fleetOwner,provisionability,templateReadiness,executionProfile,startFor,member,
    /** Fence human tools and drain existing desktop relays; does not claim physical stop. */
    async closeHumanAdmissions(){await Promise.all([...members.values()].map(async pending=>{const m=await pending;m.owner.forbidMaintenanceStart();m.worker.closeAdmission();await m.closeDesktop()}))},
    /** Only already-connected members may reconcile the original human history. */
    async reconcileConnectedHumanEffects(){
      const pending=store.pendingActions().filter(a=>a.kind==='human.relay');
      const attempts=store.getReservations().filter(r=>r.attempt.native&&pending.some(a=>a.payload.attemptId===r.attempt.id));
      await Promise.allSettled(attempts.map(async r=>{const existing=members.get(r.attempt.taskId);if(!existing)return;const member=await existing;await member.reconcileHumanEffects(r.attempt.native!,true)}));
    },
    async prepare(start:NativeStart) {ensure(!store.getLifecycle(start.attemptId).state.stopRequested,'native_interrupted','Native attempt was interrupted');ensure(store.getLifecycle(start.attemptId).reservation.status==='confirmed','native_unconfirmed','Confirm actual engine execution before native provisioning');const m=await member(start,true);await m.closeDesktop();m.assertNoHumanEffect();ensure(!store.getLifecycle(start.attemptId).state.stopRequested,'native_interrupted','Native attempt was interrupted during provisioning');await m.boundary.prepare(start,start.idempotencyKey,m.authenticate);return m.verify.requireVerifiedProfile(start)},
    async reconcile(start:NativeStart){return (await member(start)).owner.reconcile(start)},
    async close(){for(const promise of members.values()){try{const m=await promise;await m.closeDesktop();await m.owner.close()}catch{}}members.clear()},
  };
}
export type NativeFleet = ReturnType<typeof createNativeFleet>;

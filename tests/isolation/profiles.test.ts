import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveBoundary, RuntimeProfile } from '../../src/isolation/profiles.ts';
import { materializeFixture, recipeFixture } from '../helpers/fixtures.ts';

async function implementation() {
  const module = await import('../../src/isolation/verify.ts').catch(() => undefined);
  assert.ok(module?.createProfileVerifier, 'Production verifier must inspect effective native settings and tools'); return module;
}
test('verifies_effective_boundary_not_declared_flags', async () => {
  const { createProfileVerifier } = await implementation();
  const root = await mkdtemp(join(tmpdir(), 'sf-boundary-')); const workspace = join(root, 'work'); await mkdir(workspace);
  const recipe = recipeFixture('tag');
  const task = materializeFixture({ id: 'task', repository: { id: 'repo-1' } as any, recipe, request: { title: 'Test', description: 'Test' } as any, defaults: { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'result' }, source: 'manual' });
  const start = { idempotencyKey: 'key', attemptId: 'attempt', task, workspacePath: workspace, baseSha: 'sha', fence: 1, profileId: 'native' };
  const effective: EffectiveBoundary = { runtimeId: 'container', processIdentity: 'pid-start', ownerId: 'vscode', providerId: 'copilot', image: 'sha256:pinned', mounts: [{ source: workspace, target: workspace, writable: true }], networks: ['private'], tools: [], credentialRefs: [], networkDestinations: [], protectedPaths: ['/factory.sqlite', '/var/run/docker.sock', '/host-auth'], unapprovedToolsDenied: true, alternateEgressDenied: true, metadataProtected: true };
  let snapshot = structuredClone(effective); let denied = true;
  const boundary = { inspect: async () => structuredClone(snapshot), challenge: async (_start: unknown, nonce: string) => ({ nonce, runtimeId: snapshot.runtimeId, processIdentity: snapshot.processIdentity, denied, checks: ['docker-socket', 'factory-store', 'host-credentials', 'metadata-write', 'alternate-egress', 'external-tool'] }) };
  const profile: RuntimeProfile = { id: 'native', ownerId: 'vscode', providerId: 'copilot', image: 'sha256:pinned', networks: ['private'], protectedPaths: effective.protectedPaths, boundary };
  const verifier = createProfileVerifier({ profiles: [profile] });
  try {
    const proof = await verifier.requireVerifiedProfile(start); assert.equal(proof.profileId, 'native');
    for (const change of [{ image: 'other' }, { networks: ['private', 'host'] }, { tools: ['shell'] }, { credentialRefs: ['host'] }, { unapprovedToolsDenied: false }, { alternateEgressDenied: false }, { metadataProtected: false }, { mounts: [...effective.mounts, { source: root, target: '/host', writable: true }] }]) {
      snapshot = { ...structuredClone(effective), ...change }; await assert.rejects(verifier.requireVerifiedProfile(start));
    }
    snapshot = structuredClone(effective); denied = false; await assert.rejects(verifier.requireVerifiedProfile(start)); denied = true;
    const alias = join(root, 'alias'); await symlink(workspace, alias); await assert.rejects(verifier.requireVerifiedProfile({ ...start, workspacePath: alias }));
    await assert.rejects(createProfileVerifier({ profiles: [] }).requireVerifiedProfile(start));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('docker_adapter_inspects_actual_container_privilege_before_native_policy', async () => {
  const module = await import('../../src/isolation/docker.ts').catch(() => undefined);
  assert.ok(module?.createDockerNativeBoundary, 'Concrete Docker inspection adapter required');
  const root = await mkdtemp(join(tmpdir(), 'sf-docker-boundary-')); const workspace = join(root,'work'); await mkdir(workspace);
  const recipe = recipeFixture('tag'); const task = materializeFixture({ id: 'task', repository: { id:'repo-1' } as any, recipe, request:{ title:'Test',description:'Test' } as any,defaults:{ownerId:'vscode',providerId:'copilot',finishPolicy:'result'},source:'manual' });
  const start = { idempotencyKey:'key',attemptId:'attempt',task,workspacePath:workspace,baseSha:'sha',fence:1,profileId:'profile' };
  let privileged = true; let binding = { attemptId: 'attempt', fence: 1 }; let ipc = 'private';
  const docker = { command: async (args: string[]) => {
    if (args[0] === 'image') return JSON.stringify([{ Id:'image-id', RepoDigests:['node@sha256:pinned'] }]);
    if (args[0] === 'container') return JSON.stringify([{ Id:'container', Image:'image-id', State:{ Running:true,Pid:123,StartedAt:'now' }, Config:{ User:'1000:1000',Labels:{ 'sf.runtime-owner':'runtime-owner' } }, HostConfig:{ ReadonlyRootfs:true,Privileged:privileged,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],NetworkMode:'private',IpcMode:ipc,PidsLimit:64,Memory:256000000,NanoCpus:1000000000 }, Mounts:[{ Source:workspace,Destination:workspace,RW:true,Type:'bind' }],NetworkSettings:{Networks:{private:{NetworkID:'private'}}} }]);
    if (args[0] === 'network') return JSON.stringify([{ Id:'private',Internal:true,Driver:'bridge' }]);
    throw Error('Canaries not used in inspect test');
  } };
  const tools = { prepareBinding: async (start: {attemptId: string; fence: number}, _key: string) => { binding = {attemptId:start.attemptId,fence:start.fence}; }, inspect: async () => ({ ...binding, runtimeId:'container',processIdentity:'native-process',ownerId:'vscode',providerId:'copilot' as const, tools:[],credentialRefs:[],networkDestinations:[],unapprovedToolsDenied:true,alternateEgressDenied:true,metadataProtected:true }), challenge:async (_s: unknown,nonce: string)=>({nonce,runtimeId:'container',processIdentity:'native-process',denied:true,checks:[]}) };
  const boundary = module.createDockerNativeBoundary({docker,runtimeOwnerId:'runtime-owner',containerId:'container',image:'node@sha256:pinned',networks:['private'],protectedPaths:['/db','/auth','/var/run/docker.sock'],tools});
  try { await assert.rejects(boundary.inspect(start)); privileged=false; assert.equal((await boundary.inspect(start)).runtimeId,'container');
    const retry = {...start,attemptId:'retry',fence:2};await assert.rejects(boundary.inspect(retry));await tools.prepareBinding(retry,'trusted-continuation');assert.equal((await boundary.inspect(retry)).runtimeId,'container');
    await assert.rejects(boundary.inspect(start));ipc='container:foreign';await assert.rejects(boundary.inspect(retry)); }
  finally { await rm(root,{recursive:true,force:true}); }
});

test('protected_paths_with_dot_prefix_cannot_hide_inside_writable_mounts', async () => {
  const {createProfileVerifier}=await implementation();const root=await mkdtemp(join(tmpdir(),'sf-path-boundary-'));
  try {
    const recipe=recipeFixture('tag');const task=materializeFixture({id:'task',repository:{id:'repo-1'} as any,recipe,request:{title:'Test',description:'Test'} as any,defaults:{ownerId:'vscode',providerId:'copilot',finishPolicy:'result'},source:'manual'});
    const protectedPaths=[join(root,'..credentials'),'/factory.sqlite','/var/run/docker.sock'];
    const value:EffectiveBoundary={runtimeId:'runtime',processIdentity:'process',ownerId:'vscode',providerId:'copilot',image:'image',mounts:[{source:root,target:root,writable:true}],networks:['private'],tools:[],credentialRefs:[],networkDestinations:[],protectedPaths,unapprovedToolsDenied:true,alternateEgressDenied:true,metadataProtected:true};
    const profile:RuntimeProfile={id:'profile',ownerId:'vscode',providerId:'copilot',image:'image',networks:['private'],protectedPaths,boundary:{inspect:async()=>value,challenge:async(_s,nonce)=>({nonce,runtimeId:'runtime',processIdentity:'process',denied:true,checks:['docker-socket','factory-store','host-credentials','metadata-write','alternate-egress','external-tool']})}};
    await assert.rejects(createProfileVerifier({profiles:[profile]}).requireVerifiedProfile({idempotencyKey:'key',attemptId:'attempt',task,workspacePath:root,baseSha:'sha',fence:1,profileId:'profile'}));
  }finally{await rm(root,{recursive:true,force:true});}
});

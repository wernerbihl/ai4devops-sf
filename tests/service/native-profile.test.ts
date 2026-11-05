import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeFleet } from '../../src/service/native.ts';
import { fingerprint } from '../../src/storage/database.ts';
import type { RuntimeConfig, IsolatedNativeTemplate } from '../../src/service/config.ts';

const template: IsolatedNativeTemplate = { kind: 'vscode-isolated-worker-v2', nativeImage: 'native@sha256:'+'a'.repeat(64), workerImage: 'worker@sha256:'+'b'.repeat(64),
  entrypoint: '/opt/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js', entrypointSha256: 'c'.repeat(64), hostCommit: 'e576c7bbeb39772a1d1ebe472545def0d93e6d8b',
  pristineDirectory: '/workspaces/task', emptyHome: '/opt/software-factory/empty-home', credentialRef: 'private-ref',
  proxy: { image: 'proxy@sha256:'+'d'.repeat(64), entrypoint: '/opt/software-factory/connect.cjs', entrypointSha256: 'e'.repeat(64), allowedAuthorities: ['api.githubcopilot.com:443'] } };
function fleet(t: IsolatedNativeTemplate | null = template) {
  const config: RuntimeConfig = { schemaVersion: 1, installationId: 'test', allowedOrigins: ['http://127.0.0.1:5173'], repositories: [], providerCredentials: [], native: t ? [structuredClone(t)] : [] };
  let commands = 0;
  const value = createNativeFleet({ config, installation: { id: 'test', root: '/owned-fixture', docker: { async command() { commands++; throw Error('No allocation permitted'); } }, secrets: {} as never }, store: {} as never, broker: {} as never, protectedPaths: [] });
  return { value, config, commands: () => commands };
}
test('captured_native_profile_binds_real_template_build_proxy_policy_without_allocating_an_attempt', async () => {
  const f = fleet(); const descriptor = f.value.executionProfile();
  assert.ok(descriptor); assert.equal(descriptor.isolatedProfileId, 'vscode-copilot-isolated-worker-v2');
  assert.equal(descriptor.hostCommit, template.hostCommit);
  assert.equal(descriptor.nativeImage, template.nativeImage); assert.equal(descriptor.workerImage, template.workerImage);
  assert.equal((descriptor.proxy as Record<string, unknown>).image, template.proxy.image);
  assert.match(descriptor.sourceFingerprint as string, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(descriptor).includes('private-ref'), false);
  assert.equal(JSON.stringify(descriptor).includes('attempt'), false);
  f.config.native[0]!.hostCommit = 'f'.repeat(40);
  assert.deepEqual(f.value.executionProfile(), descriptor, 'Descriptor and executor use the same captured immutable template');
  for (const changed of [{ ...template, hostCommit: 'f'.repeat(40) }, { ...template, workerImage: 'worker@sha256:'+'f'.repeat(64) },
    { ...template, proxy: { ...template.proxy, allowedAuthorities: ['api.github.com:443'] } }]) {
    assert.notEqual(fingerprint(fleet(changed).value.executionProfile()), fingerprint(descriptor), 'Ready/unknown availability alone must not hide template changes');
  }
  await f.value.templateReadiness();
  assert.notEqual(fingerprint(f.value.executionProfile()), fingerprint(descriptor), 'Current availability facts must participate');
  assert.equal(f.commands(), 0);
  assert.equal(fleet(null).value.executionProfile(), undefined);
});

test('real_fleet_profile_change_while_both_templates_are_provisionable_requires_new_explicit_approval', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path'); const { createHash } = await import('node:crypto');
  const { openStore } = await import('../../src/storage/store.ts'); const { RecipeRegistry, recipePayloadHash } = await import('../../src/recipes/registry.ts');
  const { boundRecipe, boundPatch } = await import('../helpers/recipe-validation.ts');
  const { resolveNativeToolReference } = await import('../../src/owners/toolkits.ts'); const { parse } = await import('yaml');
  const root = mkdtempSync(join(tmpdir(), 'sf-profile-')); const store = openStore(':memory:'); let inspections = 0;
  try {
    mkdirSync(join(root, 'vault'), { mode: 0o700 });
    // Owned nonsecret credential fixture; no provider requests are sent.
    writeFileSync(join(root, 'vault', 'native-copilot'), 'owned-nonsecret-profile-fixture', { mode: 0o600 });
    writeFileSync(join(root, 'native-copilot.json'), JSON.stringify({ schemaVersion: 1, ref: 'native-copilot', resource: 'https://api.github.com', scopes: ['read:user','user:email'], account: { id: 'fixture', label: 'Fixture' } }), { mode: 0o600 });
    const proxyHash = createHash('sha256').update(readFileSync(new URL('../../runtime/model-proxy/connect.cjs', import.meta.url))).digest('hex');
    const trusted = { ...template, credentialRef: 'native-copilot', proxy: { ...template.proxy, entrypointSha256: proxyHash } };
    const readyFleet = (workerImage: string) => createNativeFleet({ config: { schemaVersion: 1, installationId: 'test', allowedOrigins: ['http://127.0.0.1:5173'], repositories: [],
      providerCredentials: [{ ref: 'native-copilot', providerId: 'copilot', resource: 'https://api.github.com', scopes: ['read:user','user:email'] }], native: [{ ...trusted, workerImage }] },
      installation: { id: 'test', root, docker: { async command(args) { assert.deepEqual(args.slice(0,2), ['image','inspect']); inspections++; return JSON.stringify([{ RepoDigests: [args[2]], Os: 'linux', Architecture: 'amd64' }]); } }, secrets: {} as never }, store, broker: {} as never, protectedPaths: [] });
    const first = readyFleet(template.workerImage); const second = readyFleet('worker@sha256:'+'f'.repeat(64));
    assert.deepEqual(await first.templateReadiness(), []); assert.deepEqual(await second.templateReadiness(), []);
    assert.equal(first.executionProfile()!.available, true); assert.equal(second.executionProfile()!.available, true);
    const registry = (value: typeof first) => new RecipeRegistry(store, { resolveReference: resolveNativeToolReference, executionReadiness: () => [], executionProfile: value.executionProfile });
    const a = registry(first); const b = registry(second);
    store.createRepository({ id: 'repo', name: 'Repo', url: 'https://example.test/repo' });
    const source = parse(readFileSync(new URL('../../recipes/starter/focused-feature.yaml', import.meta.url), 'utf8')); source.variables.sf.tagId = store.snapshot().tags[0]!.id;
    const input = { yaml: JSON.stringify(source), repositoryIds: ['repo'] };
    const recipe = a.createCommand(boundRecipe(a, input), { key: 'create' });
    const approval = { recipeHash: recipe.hash, payloadHash: recipePayloadHash(recipe), repositoryIds: recipe.repositoryIds, capabilities: recipe.contract.variables.sf.required };
    const approved = a.patchCommand(recipe.recipeId, boundPatch(a, recipe.recipeId, { active: true, approval }), { key: 'approve-a', expectedRevision: store.snapshot().recipes[0]!.revision });
    assert.equal(approved.ready, true); assert.equal(b.readiness(recipe).approved, false);
    const before = store.snapshot();
    assert.throws(() => b.patchCommand(recipe.recipeId, boundPatch(a, recipe.recipeId, { active: true, approval }), { key: 'stale-profile', expectedRevision: approved.revision }));
    assert.throws(() => b.patchCommand(recipe.recipeId, boundPatch(b, recipe.recipeId, { active: true }), { key: 'old-grant', expectedRevision: approved.revision }));
    assert.deepEqual({ ...store.snapshot(), at: before.at }, before); assert.equal(store.getAdmissionState().grants.length, 1);
    assert.equal(b.patchCommand(recipe.recipeId, boundPatch(b, recipe.recipeId, { active: true, approval }), { key: 'approve-b', expectedRevision: approved.revision }).ready, true);
    assert.equal(store.getAdmissionState().grants.length, 2); assert.equal(inspections, 6, 'Only image inspection, no attempt resources');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('actual_owned_image_inspection_refuses_wrong_release_labels_before_provisioning',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {expectedImageBuild}=await import('../../src/install/images.ts');
 const expected=expectedImageBuild();const root=mkdtempSync(join(tmpdir(),'sf-image-labels-'));const ids={native:'sha256:'+'a'.repeat(64),worker:'sha256:'+'b'.repeat(64),proxy:'sha256:'+'c'.repeat(64)};
 let bad:Record<string,string>={};let inspections=0;
 try{
  mkdirSync(join(root,'vault'),{mode:0o700});writeFileSync(join(root,'vault/native-copilot'),'owned-nonsecret-fixture',{mode:0o600});writeFileSync(join(root,'native-copilot.json'),JSON.stringify({schemaVersion:1,ref:'native-copilot',resource:'https://api.github.com',scopes:['read:user','user:email'],account:{id:'fixture',label:'Fixture'}}),{mode:0o600});
  const config:RuntimeConfig={schemaVersion:1,installationId:'test',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[{ref:'native-copilot',providerId:'copilot',resource:'https://api.github.com',scopes:['read:user','user:email']}],native:[{...template,nativeImage:ids.native,workerImage:ids.worker,credentialRef:'native-copilot',proxy:{...template.proxy,image:ids.proxy,entrypointSha256:expected.proxySha256}}]};
  const fleet=createNativeFleet({config,installation:{id:'test',root,docker:{async command(args){assert.deepEqual(args.slice(0,2),['image','inspect']);inspections++;const role=Object.entries(ids).find(([,id])=>id===args[2])![0];return JSON.stringify([{Id:args[2],Os:'linux',Architecture:'amd64',Config:{Labels:{'sf.installation':'test','sf.build':expected.sourceFingerprint,'sf.role':role,'sf.source':expected.sourceCommit,'sf.release':expected.releaseDigest,...bad}}}]);}},secrets:{} as never},store:{} as never,broker:{} as never,protectedPaths:[]});
  assert.deepEqual(await fleet.templateReadiness(),[]);assert.equal(inspections,3);
  for(const mutation of [{'sf.source':'f'.repeat(40)},{'sf.release':'f'.repeat(64)}]){bad=mutation;assert.match((await fleet.templateReadiness()).join(' '),/owned build/);}
  bad={};assert.deepEqual(await fleet.templateReadiness(),[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

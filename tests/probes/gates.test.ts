import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, win32 } from 'node:path';
import { checkGates, requirements, isolationAssertions, isContainedRelativePath } from '../../scripts/check-gates.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-p5-gates-'));
  const evidence = Object.entries(requirements).map(([name, requirement]) => {
    const file = `${name}.json`;
    writeFileSync(join(dir, file), JSON.stringify({ name, mode: 'live', status: 'passed', versions: requirement.versions,
      assertions: requirement.assertions.map(name => ({ name, passed: true })), artifacts: ['observed.txt'] }));
    return { id: name, file, source: 'owned diagnostic', observedAt: '2026-11-04T00:00:00Z', sha256: '' };
  });
  writeFileSync(join(dir, 'observed.txt'), 'sanitized observation');
  const manifest = { schemaVersion: 1, evidence, profiles: [] as unknown[] };
  const save = () => {
    const hash = (file: string) => createHash('sha256').update(requireRead(join(dir, file))).digest('hex');
    for (const entry of manifest.evidence) entry.sha256 = hash(entry.file);
    for (const profile of manifest.profiles as {specFile: string; evidenceFile: string; specSha256?: string; evidenceSha256?: string}[]) { profile.specSha256 = hash(profile.specFile); profile.evidenceSha256 = hash(profile.evidenceFile); }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  }; save();
  return { dir, manifest, save, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('missing gates block readiness and missing Copilot App is explicit', () => {
  const f = fixture(); try { f.manifest.evidence = []; f.save(); const summary = checkGates(f.dir); assert.equal(summary.ready, false); assert.equal(summary.blocked.includes('dashboard-copilot-app'), true); } finally { f.cleanup(); }
});
for (const change of ['blocked', 'failed', 'fixture', 'version', 'incomplete', 'duplicate-assertion', 'artifact', 'directory-artifact', 'traversal', 'malformed', 'ambiguous'] as const) {
 test(`gate refuses ${change} evidence`, () => { const f = fixture(); try {
   const file = join(f.dir, 'dashboard-bb.json'); const data = JSON.parse(String(requireRead(file)));
   if (change === 'blocked' || change === 'failed') data.status = change;
   if (change === 'fixture') data.mode = 'fixture';
   if (change === 'version') data.versions = { host: 'wrong' };
   if (change === 'incomplete') data.assertions.pop();
   if (change === 'duplicate-assertion') data.assertions.push(data.assertions[0]);
   if (change === 'artifact') data.artifacts = ['missing.txt'];
   if (change === 'directory-artifact') data.artifacts = ['.'];
   if (change === 'traversal') data.artifacts = ['../outside.txt'];
   if (change === 'malformed') data.assertions[0].passed = 'true';
   if (change === 'ambiguous') f.manifest.evidence.push(f.manifest.evidence.find(e => e.id === 'dashboard-bb')!);
   writeFileSync(file, JSON.stringify(data)); f.save(); assert.ok(checkGates(f.dir).blocked.includes('dashboard-bb'));
 } finally { f.cleanup(); } });
}
import { readFileSync as requireRead } from 'node:fs';
test('empty advertised profile list cannot pass both provider coverage or mandatory BB isolation', () => { const f = fixture(); try { const summary = checkGates(f.dir); assert.equal(summary.ready, false); assert.ok(summary.blocked.includes('provider-copilot')); assert.ok(summary.blocked.includes('provider-codex')); assert.ok(summary.blocked.includes('profile-bb-codex')); } finally { f.cleanup(); } });
test('malformed manifest blocks instead of throwing or allowing vacuous pass', () => { const f = fixture(); try { writeFileSync(join(f.dir, 'manifest.json'), '{}'); assert.equal(checkGates(f.dir).ready, false); } finally { f.cleanup(); } });

test('valid pinned evidence passes known gates; unresolved Copilot App version stays blocked', () => { const f = fixture(); try { const summary = checkGates(f.dir); assert.ok(summary.passed.includes('dashboard-bb')); assert.ok(summary.passed.includes('kestra-oss-h2')); assert.ok(summary.blocked.includes('dashboard-copilot-app')); } finally { f.cleanup(); } });
function addProfile(f: ReturnType<typeof fixture>, ownerId: string, providerId: string) {
 const id = `${ownerId}-${providerId}`;
 const required = { paths: [{ root: '/workspace', mode: 'write' }], tools: [], networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['result'] };
 const spec = { id, ownerId, providerId, required, image: 'owned-image@sha256:exact', workspaceRoot: '/workspace', version: '1' };
 const versions = ownerId === 'bb' ? requirements['dashboard-bb']!.versions : requirements['vscode-copilot']!.versions;
 const proof = { profileId: id, ownerId, providerId, verifiedAt: '2026-11-04T00:00:00Z', required, probes: [{ name: `isolation-${id}`, mode: 'live', status: 'passed', versions: { ...versions, profile: '1', image: spec.image }, assertions: isolationAssertions.map(name => ({ name, passed: true })), artifacts: ['observed.txt'] }] };
 writeFileSync(join(f.dir, `${id}-spec.json`), JSON.stringify(spec)); writeFileSync(join(f.dir, `${id}-proof.json`), JSON.stringify(proof));
 f.manifest.profiles.push({ specFile: `${id}-spec.json`, evidenceFile: `${id}-proof.json`, source: 'owned native restriction diagnostic' }); f.save();
 return proof;
}
test('actual valid profile proofs supply provider coverage and mandatory BB profile', () => { const f = fixture(); try {
 addProfile(f, 'vscode', 'copilot'); addProfile(f, 'bb', 'codex'); const summary = checkGates(f.dir);
 for (const id of ['provider-copilot', 'provider-codex', 'profile-bb-codex']) assert.ok(summary.passed.includes(id), id);
 assert.equal(summary.ready, false); // App version not established.
 } finally { f.cleanup(); } });
test('advertised profiles reject missing native restrictions and unsupported owner/provider combinations', () => { const f = fixture(); try {
 const proof = addProfile(f, 'bb', 'codex'); proof.probes[0]!.assertions.pop(); writeFileSync(join(f.dir, 'bb-codex-proof.json'), JSON.stringify(proof));
 addProfile(f, 'bb', 'copilot'); const summary = checkGates(f.dir); assert.ok(summary.blocked.includes('profile-bb-codex')); assert.ok(summary.blocked.includes('profile-bb-copilot')); assert.ok(summary.blocked.includes('provider-codex'));
 } finally { f.cleanup(); } });

test('duplicate advertised profile remains blocked rather than simultaneously passed', () => { const f = fixture(); try {
 addProfile(f, 'bb', 'codex'); f.manifest.profiles.push(f.manifest.profiles[0]); f.save(); const summary=checkGates(f.dir);
 assert.ok(summary.blocked.includes('profile-bb-codex')); assert.ok(!summary.passed.includes('profile-bb-codex')); assert.ok(summary.blocked.includes('provider-codex'));
 } finally { f.cleanup(); } });

test('receipt changes without refreshed provenance digest block the selected gate', () => { const f=fixture();try {
 const file=join(f.dir,'dashboard-bb.json');const data=JSON.parse(requireRead(file,'utf8'));data.versions.extra='changed';writeFileSync(file,JSON.stringify(data));
 assert.ok(checkGates(f.dir).blocked.includes('dashboard-bb'));
} finally {f.cleanup();} });
test('profile capability object key ordering does not change its meaning', () => { const f=fixture();try {
 const proof=addProfile(f,'vscode','copilot');proof.required={allowedFinishPolicies:['result'],credentialRefs:[],networkDestinations:[],tools:[],paths:[{root:'/workspace',mode:'write'}]};writeFileSync(join(f.dir,'vscode-copilot-proof.json'),JSON.stringify(proof));f.save();
 assert.ok(checkGates(f.dir).passed.includes('provider-copilot'));
}finally{f.cleanup();} });
test('multiple uniquely named compatible native probes can jointly prove a profile restriction set', () => { const f=fixture();try {
 const proof=addProfile(f,'bb','codex');const original=proof.probes[0]!;
 proof.probes=[{...original,name:'native-filesystem',assertions:original.assertions.slice(0,7)},{...original,name:'native-network-reconnect',assertions:original.assertions.slice(7)}];writeFileSync(join(f.dir,'bb-codex-proof.json'),JSON.stringify(proof));f.save();
 assert.ok(checkGates(f.dir).passed.includes('provider-codex'));
 proof.probes[1]!.name=proof.probes[0]!.name;writeFileSync(join(f.dir,'bb-codex-proof.json'),JSON.stringify(proof));f.save();assert.ok(checkGates(f.dir).blocked.includes('provider-codex'));
}finally{f.cleanup();} });

test('containment rejects parent and other-drive Windows relative results', () => {
 const root='C:\\release\\evidence';
 for(const candidate of ['C:\\release\\outside.json','C:\\release\\evidence-other\\receipt.json','D:\\other\\receipt.json']) {
  const rel=win32.relative(root,candidate);assert.equal(isContainedRelativePath(rel,win32.isAbsolute),false,rel);
 }
 assert.equal(isContainedRelativePath(win32.relative(root,'C:\\release\\evidence\\nested\\receipt.json'),win32.isAbsolute),true);
});
for(const kind of ['manifest-receipt','profile-spec','artifact'] as const) for(const link of [false,true]) {
 test(`containment rejects an existing outside ${kind} through ${link?'directory symlink or Windows junction':'parent reference'}`,()=>{
  const f=fixture(),outside=mkdtempSync(join(tmpdir(),'sf-p5-existing-outside-'));
  try {
   if(kind==='profile-spec') {addProfile(f,'bb','codex');assert.ok(checkGates(f.dir).passed.includes('provider-codex'));}
   else assert.ok(checkGates(f.dir).passed.includes('dashboard-bb'));
   const entry=f.manifest.evidence.find(entry=>entry.id==='dashboard-bb')!;
   const profile=f.manifest.profiles[0] as {specFile:string}|undefined;
   const source=kind==='manifest-receipt'?entry.file:kind==='profile-spec'?profile!.specFile:'observed.txt';
   const destination=join(outside,'existing-file');writeFileSync(destination,requireRead(join(f.dir,source)));
   if(link) symlinkSync(outside,join(f.dir,'escaped'),'junction');
   const reference=link?'escaped/existing-file':relative(f.dir,destination);
   if(kind==='manifest-receipt') entry.file=reference;
   else if(kind==='profile-spec') profile!.specFile=reference;
   else {const file=join(f.dir,entry.file);const data=JSON.parse(requireRead(file,'utf8'));data.artifacts=[reference];writeFileSync(file,JSON.stringify(data));}
   f.save();const summary=checkGates(f.dir);
   assert.ok(summary.blocked.includes(kind==='profile-spec'?'provider-codex':'dashboard-bb'));
  } finally {f.cleanup();rmSync(outside,{recursive:true,force:true});}
 });
}

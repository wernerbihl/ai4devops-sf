import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntimeConfig } from '../../src/service/config.ts';
import { expectedImageBuild } from '../../src/install/images.ts';

test('local image IDs require a protected manifest bound to the installed source and runtime template', () => {
  const root=mkdtempSync(join(tmpdir(),'sf-image-manifest-')); const ids={native:'sha256:'+'a'.repeat(64),worker:'sha256:'+'b'.repeat(64),proxy:'sha256:'+'c'.repeat(64)};
  const base=expectedImageBuild(); const entry='/opt/software-factory/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js';
  const manifest={schemaVersion:1,installationId:'fixture',...base,images:ids,nativeEntrypoint:entry,nativeEntrypointSha256:'d'.repeat(64)};
  const config={schemaVersion:1,installationId:'fixture',allowedOrigins:['http://127.0.0.1:4000'],repositories:[],providerCredentials:[{ref:'native',providerId:'copilot',resource:'https://api.github.com',expiresAt:'2099-01-01T00:00:00Z',scopes:[]}],native:[{kind:'vscode-isolated-worker-v2',nativeImage:ids.native,workerImage:ids.worker,entrypoint:entry,entrypointSha256:'d'.repeat(64),hostCommit:base.hostCommit,pristineDirectory:'/workspaces/task',emptyHome:'/opt/software-factory/empty-home',credentialRef:'native',proxy:{image:ids.proxy,entrypoint:'/opt/software-factory/connect.cjs',entrypointSha256:base.proxySha256,allowedAuthorities:['api.githubcopilot.com:443']}}]};
  try {
    writeFileSync(join(root,'runtime.json'),JSON.stringify(config),{mode:0o600});
    assert.throws(()=>loadRuntimeConfig(root,'fixture'));
    writeFileSync(join(root,'owned-images.json'),JSON.stringify(manifest),{mode:0o600});
    assert.equal(loadRuntimeConfig(root,'fixture').native[0]?.nativeImage,ids.native);
    writeFileSync(join(root,'owned-images.json'),JSON.stringify({...manifest,sourceFingerprint:'0'.repeat(64)}));
    assert.throws(()=>loadRuntimeConfig(root,'fixture'));
  } finally {rmSync(root,{recursive:true});}
});

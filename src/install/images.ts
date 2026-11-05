import { createHash } from 'node:crypto';
import { workerProgram } from '../owners/worker-program.ts';
import { constants, copyFileSync, createReadStream, mkdtempSync, openSync, closeSync, fstatSync, lstatSync, fsyncSync, unlinkSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerPort } from '../kestra/deployment.ts';
import { writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { privateDirectory } from '../kestra/executions.ts';

/** Microsoft update metadata for the exact inspected source commit, not a mutable tag. */
export const nativeServerAsset = {
  commit: 'e576c7bbeb39772a1d1ebe472545def0d93e6d8b',
  url: 'https://vscode.download.prss.microsoft.com/dbazure/download/insider/e576c7bbeb39772a1d1ebe472545def0d93e6d8b/vscode-server-linux-x64.tar.gz',
  sha256: '65fb417a7670db3a28f299072e06c7dacad77fcbb50472cb542721098d563c1b',
} as const;
const imagesPath = new URL(import.meta.url.endsWith('.ts') ? '../../release/images.json' : '../runtime/kestra/images.json', import.meta.url);
const workerBase = (JSON.parse(readFileSync(imagesPath, 'utf8')) as {worker:{image:string}}).worker.image;
if (!/^node@sha256:[a-f0-9]{64}$/.test(workerBase)) throw new Error('Invalid pinned image source');

/** Scratch stage copies filesystem only: inherited Config.Env and entrypoint are not copied. */
export function buildRecipes() {
  const base = `FROM ${workerBase} AS base\nFROM scratch\nCOPY --from=base / /\n`;
  const nativeEnv = 'ENV PATH=/usr/local/bin:/usr/bin:/bin\nENV HOME=/opt/software-factory/empty-home\nENV LANG=C.UTF-8\nENV SF_CONTROL_SENTINEL=sf-nonsecret-control-sentinel\n';
  const workerEnv = 'ENV PATH=/usr/local/bin:/usr/bin:/bin\nENV HOME=/tmp\nENV LANG=C.UTF-8\n';
  return {
    native: `${base}ADD vscode-server.tar.gz /opt/software-factory/vscode/\nRUN mkdir -p /workspaces/task /opt/software-factory/empty-home && chmod 0555 /workspaces/task /opt/software-factory/empty-home\n${nativeEnv}`,
    worker: `${base}RUN mkdir -p /workspaces/task\n${workerEnv}`,
    proxy: `${base}COPY connect.cjs /opt/software-factory/connect.cjs\n${workerEnv}`,
  };
}
export async function verifySha256(path: string, expected: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid expected archive hash');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  if (hash.digest('hex') !== expected) throw new Error('Pinned archive checksum mismatch');
}


export function expectedImageBuild() {
  const proxySource = new URL(import.meta.url.endsWith('.ts') ? '../../runtime/model-proxy/connect.cjs' : '../runtime/model-proxy/connect.cjs', import.meta.url);
  const proxySha256 = createHash('sha256').update(readFileSync(proxySource)).digest('hex');
  const workerProgramSha256 = createHash('sha256').update(workerProgram).digest('hex');
  const builderSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  const sourceFingerprint = createHash('sha256').update(JSON.stringify({schemaVersion:1, recipes:buildRecipes(), baseImage:workerBase, hostCommit:nativeServerAsset.commit, serverArchiveSha256:nativeServerAsset.sha256, proxySha256,workerProgramSha256,builderSha256})).digest('hex');
  return {sourceFingerprint,baseImage:workerBase,serverArchiveSha256:nativeServerAsset.sha256,hostCommit:nativeServerAsset.commit,proxySha256,workerProgramSha256,builderSha256};
}

export interface OwnedImageBuild {
  schemaVersion: 1; installationId: string; sourceFingerprint: string; baseImage: string;
  serverArchiveSha256: string; hostCommit: string; proxySha256: string; workerProgramSha256: string; builderSha256: string;
  images: { native: string; worker: string; proxy: string };
  nativeEntrypoint: string; nativeEntrypointSha256: string;
}

function createPrivateRecord(root: string, name: string, value: object): void {
  const directory = privateDirectory(root);
  if(process.platform==='win32'){writeWindowsPrivateFile(join(directory,name),Buffer.from(JSON.stringify(value)));return}
  const fd = openSync(join(directory,name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dir = openSync(directory,constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function createImageBuildIntent(root: string, input: {installationId:string;sourceFingerprint:string}): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.installationId) || !/^[a-f0-9]{64}$/.test(input.sourceFingerprint)) throw new Error('Invalid image build intent');
  createPrivateRecord(root,'image-build-intent.json',{schemaVersion:1,...input});
}

/** Fetch only the pinned Microsoft asset into a new owned file after confirmation. */
export async function downloadNativeServer(path: string): Promise<void> {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const identity = fstatSync(fd); let complete = false;
  try {
    const response = await fetch(nativeServerAsset.url, {redirect:'error',signal:AbortSignal.timeout(600_000)});
    if (!response.ok || !response.body || response.url !== nativeServerAsset.url) throw new Error('Pinned server download unavailable');
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024 * 1024) throw new Error('Pinned server download too large');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) { const n = writeSync(fd,chunk,offset,chunk.length-offset); if (n <= 0) throw new Error('Download write failed'); offset += n; }
    }
    if (hash.digest('hex') !== nativeServerAsset.sha256) throw new Error('Pinned archive checksum mismatch');
    fsyncSync(fd); complete = true;
  } finally {
    closeSync(fd);
    if (!complete) { try { const current=lstatSync(path); if (current.dev===identity.dev && current.ino===identity.ino) unlinkSync(path); } catch { /* Retain uncertain paths for attention. */ } }
  }
}

/** Called only after installation confirmation. The input archive must match the pinned official digest. */
export async function buildImages(input: { installationId: string; installationRoot: string; archive: string; docker: DockerPort }): Promise<OwnedImageBuild> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.installationId)) throw new Error('Invalid installation identity');
  const uid = process.platform === 'win32' ? 1000 : process.getuid!();
  const gid = process.platform === 'win32' ? 1000 : process.getgid!();
  if (uid <= 0 || gid < 0) throw new Error('Image verification requires a nonroot user');
  await verifySha256(input.archive, nativeServerAsset.sha256);
  const proxySource = new URL(import.meta.url.endsWith('.ts') ? '../../runtime/model-proxy/connect.cjs' : '../runtime/model-proxy/connect.cjs', import.meta.url);
  const proxyBytes = readFileSync(proxySource);
  const proxySha256 = createHash('sha256').update(proxyBytes).digest('hex');
  const recipes = buildRecipes();
  const { sourceFingerprint, workerProgramSha256, builderSha256, proxySha256: expectedProxySha256 } = expectedImageBuild();
  if (proxySha256 !== expectedProxySha256) throw new Error('Proxy source changed during image planning');
  createImageBuildIntent(input.installationRoot,{installationId:input.installationId,sourceFingerprint});
  const context = mkdtempSync(join(tmpdir(),'sf-image-build-'));
  const images: Partial<OwnedImageBuild['images']> = {};
  try {
    copyFileSync(input.archive, join(context,'vscode-server.tar.gz'));
    await verifySha256(join(context,'vscode-server.tar.gz'), nativeServerAsset.sha256);
    writeFileSync(join(context,'connect.cjs'),proxyBytes,{mode:0o600,flag:'wx'});
    for (const [role, recipe] of Object.entries(recipes)) writeFileSync(join(context,`Dockerfile.${role}`),recipe,{mode:0o600,flag:'wx'});
    let base: any;
    try { base = JSON.parse(await input.docker.command(['image','inspect',workerBase]))[0]; }
    catch { await input.docker.command(['pull',workerBase]); base = JSON.parse(await input.docker.command(['image','inspect',workerBase]))[0]; }
    if (!base?.RepoDigests?.includes(workerBase) || base.Os !== 'linux' || base.Architecture !== 'amd64') throw new Error('Pinned base image inspection failed');
    for (const role of ['native','worker','proxy'] as const) {
      const iidfile = join(context,`iid-${role}`);
      await input.docker.command(['build','--pull=false','--network=none','--platform','linux/amd64','--label',`sf.installation=${input.installationId}`,'--label',`sf.build=${sourceFingerprint}`,'--label',`sf.role=${role}`,'--iidfile',iidfile,'-f',join(context,`Dockerfile.${role}`),context]);
      const id = readFileSync(iidfile,'utf8').trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return an immutable image ID');
      const image = JSON.parse(await input.docker.command(['image','inspect',id]))[0];
      const env = role === 'native' ? ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/opt/software-factory/empty-home','LANG=C.UTF-8','SF_CONTROL_SENTINEL=sf-nonsecret-control-sentinel'] : ['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','LANG=C.UTF-8'];
      if (image?.Id !== id || image.Os !== 'linux' || image.Architecture !== 'amd64' || image.Config?.Entrypoint?.length || JSON.stringify(image.Config?.Env) !== JSON.stringify(env) || image.Config?.Labels?.['sf.build'] !== sourceFingerprint || image.Config?.Labels?.['sf.role'] !== role || image.Config?.Labels?.['sf.installation'] !== input.installationId) throw new Error('Built image inspection failed');
      images[role] = id;
    }
    const inspectScript = `const fs=require('node:fs'),c=require('node:crypto');const names=['/opt/software-factory/vscode/vscode-server-linux-x64/out/vs/platform/agentHost/node/agentHostServerMain.js','/opt/software-factory/vscode/out/vs/platform/agentHost/node/agentHostServerMain.js'].filter(p=>fs.existsSync(p));if(names.length!==1||fs.readdirSync('/workspaces/task').length||fs.readdirSync('/opt/software-factory/empty-home').length)process.exit(1);console.log(JSON.stringify({entrypoint:names[0],sha256:c.createHash('sha256').update(fs.readFileSync(names[0])).digest('hex')}));`;
    const inspected = JSON.parse(await input.docker.command(['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--user',`${uid}:${gid}`,'--label',`sf.installation=${input.installationId}`,'--label','sf.component=image-verification','--entrypoint','node',images.native!,'-e',inspectScript]));
    if (typeof inspected.entrypoint !== 'string' || !inspected.entrypoint.startsWith('/opt/software-factory/vscode/') || !inspected.entrypoint.endsWith('/out/vs/platform/agentHost/node/agentHostServerMain.js') || !/^[a-f0-9]{64}$/.test(inspected.sha256)) throw new Error('Official native AgentHost entrypoint is unavailable');
    const manifest: OwnedImageBuild = {schemaVersion:1,installationId:input.installationId,sourceFingerprint,baseImage:workerBase,serverArchiveSha256:nativeServerAsset.sha256,hostCommit:nativeServerAsset.commit,proxySha256,workerProgramSha256,builderSha256,images:images as OwnedImageBuild['images'],nativeEntrypoint:inspected.entrypoint,nativeEntrypointSha256:inspected.sha256};
    createPrivateRecord(input.installationRoot,'owned-images.json',manifest);
    return manifest;
  } finally { rmSync(context,{recursive:true,force:true}); }
}

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readWindowsPrivateFile, readWindowsSecret } from '../platform/windows-private.ts';
import { isImagePin } from '../isolation/image.ts';
import { expectedImageBuild, type OwnedImageBuild } from '../install/images.ts';
import type { RepositoryAccess } from '../github/capabilities.ts';
import { validateRepositories } from '../github/capabilities.ts';
import type { SelectedIdentity } from '../github/store.ts';
import { ensure } from '../storage/database.ts';
export interface ProviderCredentialReference { ref: string; providerId: 'copilot'; resource: string; expiresAt?: string; scopes: string[]; }
export interface IsolatedNativeTemplate {
  kind: 'vscode-isolated-worker-v2'; nativeImage: string; workerImage: string;
  entrypoint: string; entrypointSha256: string; hostCommit: string;
  pristineDirectory: '/workspaces/task'; emptyHome: '/opt/software-factory/empty-home';
  credentialRef: string;
  proxy: { image: string; entrypoint: string; entrypointSha256: string; allowedAuthorities: string[] };
}
/** E7 writes runtime.json with private permissions. Secrets are separate vault files, never fields here. */
export interface RuntimeConfig {
  schemaVersion: 1; installationId: string; allowedOrigins: string[];
  repositories: (RepositoryAccess & { baseRef: string })[];
  selectedIdentity?: SelectedIdentity;
  providerCredentials: ProviderCredentialReference[];
  native: IsolatedNativeTemplate[];
  apiPort?: number;
}
export function readPrivateFile(path: string): Buffer {
  if(process.platform==='win32'){const value=readWindowsPrivateFile(path);ensure(value.length<=1_048_576,'private_size','Private file exceeds the size limit');return value}
  ensure(resolve(path) === path && realpathSync(path) === path, 'private_path', 'Private file must be canonical');
  const stat = lstatSync(path);
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0 && stat.size <= 1_048_576, 'private_permissions', 'Private file permissions or ownership are invalid');
  return readFileSync(path);
}
function keys(value: object, allowed: string[]) { ensure(Object.keys(value).every(k => allowed.includes(k)), 'runtime_config', 'Unknown runtime config field; secrets belong in the vault'); }
const pin = isImagePin;
export function loadRuntimeConfig(root: string, installationId: string, preloaded?:{config:Buffer;manifest?:Buffer}): RuntimeConfig {
  const value = JSON.parse((preloaded?.config??readPrivateFile(join(root, 'runtime.json'))).toString()) as RuntimeConfig;
  keys(value, ['schemaVersion','installationId','allowedOrigins','repositories','selectedIdentity','providerCredentials','native','apiPort']);
  ensure(value.schemaVersion === 1 && value.installationId === installationId && Array.isArray(value.allowedOrigins) && value.allowedOrigins.length > 0
    && value.allowedOrigins.every(origin => { try { const url = new URL(origin); return url.origin === origin && ['http:','https:'].includes(url.protocol); } catch { return false; } }), 'runtime_config', 'Exact installation and UI origins required');
  ensure(Array.isArray(value.repositories) && Array.isArray(value.providerCredentials) && Array.isArray(value.native), 'runtime_config', 'Explicit repository, credential and native configuration required');
  validateRepositories(value.repositories);
  for (const repo of value.repositories) { keys(repo, ['id','owner','name','operations','baseRef']); ensure(/^refs\/heads\/[\w./-]+$/.test(repo.baseRef) && !repo.baseRef.includes('..'), 'runtime_config', 'Explicit safe repository base ref required'); }
  for (const ref of value.providerCredentials) {
    keys(ref, ['ref','providerId','resource','expiresAt','scopes']);
    ensure(/^[a-zA-Z0-9_-]{1,100}$/.test(ref.ref) && ref.providerId === 'copilot' && new URL(ref.resource).protocol === 'https:' && (ref.expiresAt === undefined || typeof ref.expiresAt === 'string' && Number.isFinite(Date.parse(ref.expiresAt))) && Array.isArray(ref.scopes) && ref.scopes.every(s => typeof s === 'string'), 'runtime_config', 'Invalid provider credential reference');
  }
  for (const native of value.native) {
    keys(native, ['kind','nativeImage','workerImage','entrypoint','entrypointSha256','hostCommit','pristineDirectory','emptyHome','credentialRef','proxy']);
    keys(native.proxy, ['image','entrypoint','entrypointSha256','allowedAuthorities']);
    ensure(native.kind === 'vscode-isolated-worker-v2' && pin(native.nativeImage) && pin(native.workerImage) && pin(native.proxy.image)
      && native.entrypoint.startsWith('/opt/') && native.entrypoint.endsWith('/out/vs/platform/agentHost/node/agentHostServerMain.js')
      && /^[a-f0-9]{64}$/.test(native.entrypointSha256) && /^[a-f0-9]{40}$/.test(native.hostCommit)
      && native.pristineDirectory === '/workspaces/task' && native.emptyHome === '/opt/software-factory/empty-home'
      && native.proxy.entrypoint.startsWith('/opt/') && /^[a-f0-9]{64}$/.test(native.proxy.entrypointSha256)
      && value.providerCredentials.some(ref => ref.ref === native.credentialRef)
      && native.proxy.allowedAuthorities.length > 0 && native.proxy.allowedAuthorities.every(host => /^[a-z0-9][a-z0-9.-]+:443$/.test(host)), 'runtime_config', 'Pinned isolated native/worker/proxy template required');
  }
  for (const native of value.native) {
    const images = [native.nativeImage, native.workerImage, native.proxy.image];
    if (images.some(image => image.startsWith('sha256:'))) {
      ensure(images.every(image => /^sha256:[a-f0-9]{64}$/.test(image)), 'owned_image', 'All locally built images require one owned build');
      const manifest = JSON.parse((preloaded?.manifest??readPrivateFile(join(root,'owned-images.json'))).toString()) as OwnedImageBuild;
      const expected = expectedImageBuild();
      keys(manifest, ['schemaVersion','installationId','sourceFingerprint','baseImage','serverArchiveSha256','hostCommit','proxySha256','workerProgramSha256','builderSha256','images','nativeEntrypoint','nativeEntrypointSha256']);
      ensure(manifest.images && Object.keys(manifest.images).length === 3 && Object.keys(manifest.images).every(k => ['native','worker','proxy'].includes(k)), 'owned_image', 'Invalid owned image roles');
      ensure(manifest && manifest.schemaVersion === 1 && manifest.installationId === installationId && Object.keys(expected).every(k => manifest[k as keyof typeof expected] === expected[k as keyof typeof expected])
        && manifest.images?.native === native.nativeImage && manifest.images?.worker === native.workerImage && manifest.images?.proxy === native.proxy.image
        && manifest.nativeEntrypoint === native.entrypoint && manifest.nativeEntrypointSha256 === native.entrypointSha256 && native.hostCommit === expected.hostCommit && native.proxy.entrypointSha256 === expected.proxySha256 && native.proxy.entrypoint === '/opt/software-factory/connect.cjs',
        'owned_image', 'Protected owned image manifest does not match the installed source or native template');
    }
  }
  ensure(value.native.length <= 1 && (value.apiPort === undefined || Number.isInteger(value.apiPort) && value.apiPort >= 0 && value.apiPort <= 65535), 'runtime_config', 'Unsupported runtime configuration');
  return value;
}
export function readVaultSecret(root: string, ref: string): Buffer {
  ensure(/^[a-zA-Z0-9_-]{1,100}$/.test(ref), 'vault_reference', 'Invalid vault reference');
  const path=join(root,'vault',ref);if(process.platform==='win32'){const value=readWindowsSecret(path);ensure(value.length<=1_048_576,'vault_size','Vault item exceeds the size limit');return value}
  return readPrivateFile(path);
}

/** Asynchronous protected reads for live controller paths. */
export async function readPrivateFileAsync(path:string):Promise<Buffer>{
  if(process.platform!=='win32')return readPrivateFile(path);
  const {readWindowsPrivateFileAsync}=await import('../platform/windows-private.ts');const value=await readWindowsPrivateFileAsync(path);ensure(value.length<=1_048_576,'private_size','Private file exceeds the size limit');return value;
}
export async function readVaultSecretAsync(root:string,ref:string):Promise<Buffer>{
  if(process.platform!=='win32')return readVaultSecret(root,ref);
  ensure(/^[a-zA-Z0-9_-]{1,100}$/.test(ref),'vault_reference','Invalid vault reference');
  const {readWindowsSecretAsync}=await import('../platform/windows-private.ts');const value=await readWindowsSecretAsync(join(root,'vault',ref));ensure(value.length<=1_048_576,'vault_size','Vault item exceeds the size limit');return value;
}

export async function loadRuntimeConfigAsync(root:string,id:string):Promise<RuntimeConfig>{
 if(process.platform!=='win32')return loadRuntimeConfig(root,id);
 const config=await readPrivateFileAsync(join(root,'runtime.json'));const parsed=JSON.parse(config.toString());const needs=Array.isArray(parsed.native)&&parsed.native.some((n:any)=>[n?.nativeImage,n?.workerImage,n?.proxy?.image].some((v:any)=>typeof v==='string'&&v.startsWith('sha256:')));
 const manifest=needs?await readPrivateFileAsync(join(root,'owned-images.json')):undefined;return loadRuntimeConfig(root,id,{config,...(manifest?{manifest}:{})});
}

import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
import { protectWindowsDirectoryAsync, readWindowsPrivateFile, readWindowsPrivateFileAsync, readWindowsSecretAsync, writeWindowsPrivateFile, writeWindowsPrivateFileAsync, writeWindowsSecretAsync } from '../platform/windows-private.ts';
import { canonical, fingerprint } from '../storage/database.ts';
import { check, KestraError, privateDirectory, privateDirectoryAsync } from './executions.ts';
import type { EngineTransport } from './executions.ts';

export interface DockerPort { command(args: string[], options?: { stdin?: string }): Promise<string>; }
/** Configurable executable, shell:false, bounded output, errors never include argv/stdin/daemon secrets. */
export class ProcessDocker implements DockerPort {
  readonly executable: string;
  constructor(executable = 'docker') { this.executable = executable; }
  command(args: string[], options: { stdin?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = []; let bytes = 0; let failed = false;
      const fail = () => { if (failed) return; failed = true; child.kill('SIGKILL'); reject(new KestraError('Docker operation uncertain; inspect owned resources before retry')); };
      const timer = setTimeout(fail, 120_000);
      child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 24 * 1024 * 1024) fail(); else chunks.push(b); });
      child.stderr.resume(); child.on('error', fail); child.stdin.on('error', fail);
      child.on('close', code => { clearTimeout(timer); if (failed) return; if (code !== 0) fail(); else resolve(Buffer.concat(chunks).toString('utf8').trim()); });
      child.stdin.end(options.stdin ?? '');
    });
  }
}
export interface InstallationSecrets { username: string; password: string; encryptionKey: string; }
/** Separate from GitHub OAuth. Windows E7 must protect both stored secrets and runtime config ACLs. */
export interface InstallationSecretStore {
  loadOrCreate(installationId: string, root: string): Promise<InstallationSecrets>;
  protectRuntimeDirectory?(path: string): Promise<void>;
}
function readPrivate(path: string): string {
  if(process.platform==='win32')return readWindowsPrivateFile(path).toString('utf8');
  const s = lstatSync(path); check(s.isFile() && !s.isSymbolicLink() && (s.uid === process.getuid!() && (s.mode & 0o077) === 0), 'Unsafe private file permissions/ownership');
  return readFileSync(path, 'utf8');
}
function createPrivate(path: string, content: string): void {
  if(process.platform==='win32'){if(existsSync(path)){const error=new Error('File exists') as NodeJS.ErrnoException;error.code='EEXIST';throw error}writeWindowsPrivateFile(path,Buffer.from(content));return}
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
async function ensurePrivateContent(path: string, content: string): Promise<void> {
  if(process.platform==='win32'){if(!existsSync(path))await writeWindowsPrivateFileAsync(path,Buffer.from(content));check((await readWindowsPrivateFileAsync(path)).toString('utf8')===content,'Managed configuration mismatch; do not overwrite or adopt');return}
  try { createPrivate(path, content); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  check(readPrivate(path) === content, 'Managed configuration mismatch; do not overwrite or adopt');
}
export class PosixInstallationSecrets implements InstallationSecretStore {
  async loadOrCreate(id: string, root: string): Promise<InstallationSecrets> {
    check(process.platform !== 'win32', 'Windows requires an installation secret protector');
    const path = join(privateDirectory(root), 'kestra-secrets.json');
    try { createPrivate(path, JSON.stringify({ id, username: 'factory@localhost.invalid', password: randomBytes(32).toString('base64url'), encryptionKey: randomBytes(32).toString('base64') })); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const value = JSON.parse(readPrivate(path)); check(value.id === id, 'Installation secret identity mismatch');
    return { username: value.username, password: value.password, encryptionKey: value.encryptionKey };
  }
}
/** DPAPI CurrentUser protects persisted Windows engine credentials; ACLs protect runtime directories. */
export class WindowsInstallationSecrets implements InstallationSecretStore {
  async protectRuntimeDirectory(path:string):Promise<void>{await protectWindowsDirectoryAsync(path)}
  async loadOrCreate(id:string,root:string):Promise<InstallationSecrets>{
    if(process.platform!=='win32')throw new Error('Windows secret storage requires Windows');
    const path=join(await privateDirectoryAsync(root),'kestra-secrets.dpapi');
    if(!existsSync(path))await writeWindowsSecretAsync(path,Buffer.from(JSON.stringify({id,username:'factory@localhost.invalid',password:randomBytes(32).toString('base64url'),encryptionKey:randomBytes(32).toString('base64')})));
    const value=JSON.parse((await readWindowsSecretAsync(path)).toString('utf8')) as InstallationSecrets & {id:string};
    check(value.id===id,'Installation secret identity mismatch');return {username:value.username,password:value.password,encryptionKey:value.encryptionKey};
  }
}
export interface Installation { id: string; root: string; docker: DockerPort; secrets: InstallationSecretStore; }
export interface KestraHandle {
  installationId: string; containerId: string; transportContainerId: string; journalDirectory: string;
  /** E3 exclusively attaches its trusted broker with this alias. Never attach untrusted workers here. */
  brokerNetwork: { id: string; name: string; alias: 'sf-broker'; port: 8080 };
  request: EngineTransport;
}
const assets = new URL(import.meta.url.endsWith('.ts') ? '../../runtime/kestra/' : '../runtime/kestra/', import.meta.url);
const pins = JSON.parse(readFileSync(new URL(import.meta.url.endsWith('.ts') ? '../../release/images.json' : '../runtime/kestra/images.json', import.meta.url), 'utf8'));
export const kestraImagePins: { platform: string; kestra: { image: string }; worker: { image: string } } = pins;
export function dockerBind(source: string, destination: string, readOnly = false): string {
  const csv = (s: string) => /[,"\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  return ['type=bind', csv('src=' + source), csv('dst=' + destination), ...(readOnly ? ['readonly'] : [])].join(',');
}
const restrictions = ['--pull', 'never', '--platform', pins.platform, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=1777'];
const transportScript = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{try{const p=JSON.parse(input);const headers={Authorization:'Basic '+Buffer.from(p.credentials.username+':'+p.credentials.password).toString('base64')};let body;if(p.request.method!=='GET'){if(typeof p.request.body==='string'){body=p.request.body;headers['Content-Type']=p.request.path.startsWith('/flows')?'application/x-yaml':'text/plain';}else if(p.request.body){body=new FormData();for(const[k,v]of Object.entries(p.request.body))body.set(k,v);}}const r=await fetch('http://127.0.0.1:8080/api/v1/main'+p.request.path,{method:p.request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(20000)});let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.length;if(size>16777216)throw Error();chunks.push(chunk);}const text=Buffer.concat(chunks).toString('utf8');process.stdout.write(JSON.stringify({status:r.status,body:text?JSON.parse(text):null}));}catch{process.exitCode=1;}});`;
/** Private authenticated transport; credentials cross stdin only, never Docker argv or published ports. */
export function createEngineTransport(docker: DockerPort, transportContainerId: string, secrets: InstallationSecrets): EngineTransport {
  return async input => {
    check(/^\/(flows|executions)(\/|\?|$)/.test(input.path) && !/[\r\n#]/.test(input.path), 'Invalid private engine API path');
    return JSON.parse(await docker.command(['exec', '-i', transportContainerId, 'node', '-e', transportScript], { stdin: JSON.stringify({ credentials: { username: secrets.username, password: secrets.password }, request: input }) }));
  };
}
/** Mutating setup step; E7 calls only AFTER installation confirmation, never from preview. */
export async function ensureKestra(installation: Installation): Promise<KestraHandle> {
  check(/^[A-Za-z0-9_-]{1,100}$/.test(installation.id), 'Invalid installation id');
  check(process.platform !== 'win32' || installation.secrets.protectRuntimeDirectory, 'Windows private runtime protector unavailable');
  const uid = process.platform === 'win32' ? 1000 : process.getuid!(); const gid = process.platform === 'win32' ? 1000 : process.getgid!();
  check(uid > 0, 'Run the factory installation as a non-root user');
  const user = `${uid}:${gid}`; const tmpfs = `rw,nosuid,nodev,noexec,uid=${uid},gid=${gid},mode=1777`;
  const effectiveRestrictions = restrictions.map(value => value === '1000:1000' ? user : value === '/tmp:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=1777' ? '/tmp:' + tmpfs : value);
  const root = await privateDirectoryAsync(installation.root); const dir = await privateDirectoryAsync(join(root, 'kestra'));
  const configDir = await privateDirectoryAsync(join(dir, 'config')); const dataDir = await privateDirectoryAsync(join(dir, 'data')); const journalDirectory = await privateDirectoryAsync(join(dir, 'journal'));
  if (process.platform === 'win32') for (const path of [root, dir, configDir, dataDir, journalDirectory]) await installation.secrets.protectRuntimeDirectory!(path);
  const secrets = await installation.secrets.loadOrCreate(installation.id, root);
  check(secrets.username.length > 0 && !secrets.username.includes(':') && secrets.password.length >= 32 && Buffer.from(secrets.encryptionKey, 'base64').length === 32 && Buffer.from(secrets.encryptionKey, 'base64').toString('base64') === secrets.encryptionKey, 'Invalid protected engine credentials');
  const config = parse(readFileSync(new URL('application.yaml', assets), 'utf8'));
  check(config.kestra.repository.type === 'h2' && config.kestra.queue.type === 'h2' && config.kestra.variables['recursive-rendering'] === false && config.kestra.plugins['auto-install'].enabled === false && config.datasources.h2.url.startsWith('jdbc:h2:file:/app/data/database;'), 'Unsafe pinned engine configuration');
  config.kestra.server = { 'basic-auth': { username: secrets.username, password: secrets.password } };
  config.kestra.encryption = { 'secret-key': secrets.encryptionKey };
  await ensurePrivateContent(join(configDir, 'application.yaml'), JSON.stringify(config));
  const docker = installation.docker; const owner = fingerprint({ id: installation.id, root }); const prefix = 'sf-' + owner.slice(0, 24);
  const labels = { 'sf.installation': installation.id, 'sf.owner': owner, 'sf.component': 'kestra' };
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
  const inspect = async (kind: string, name: string): Promise<any | undefined> => {
    // Distinguish absence from daemon uncertainty using a successful list query, not caught inspect alone.
    try { return JSON.parse(await docker.command([kind, 'inspect', name]))[0]; }
    catch { const listed = await docker.command([kind, 'ls', ...(kind === 'container' ? ['--all'] : []), '--filter', `name=^${name}$`, '--format', '{{.ID}}']); check(!listed.trim(), 'Owned resource inspection uncertain'); return undefined; }
  };
  const imageIds = new Map<string, string>(); const imageConfigs = new Map<string, any>();
  for (const image of [pins.kestra.image, pins.worker.image]) {
    const value = JSON.parse(await docker.command(['image', 'inspect', image]))[0];
    check(value.RepoDigests?.includes(image) && value.Os === 'linux' && value.Architecture === 'amd64', 'Pinned linux/amd64 image unavailable'); imageIds.set(image, value.Id); imageConfigs.set(image, value.Config);
  }
  const networkName = prefix + '-engine'; let network = await inspect('network', networkName);
  if (!network) {
    try { await docker.command(['network', 'create', '--internal', '--driver', 'bridge', ...labelArgs, networkName]); } catch { /* deterministic name, reconcile unknown creation */ }
    network = await inspect('network', networkName);
  }
  check(network && network.Name === networkName && network.Internal === true && network.Driver === 'bridge' && Object.entries(labels).every(([k, v]) => network.Labels?.[k] === v) && Object.entries(network.Options ?? {}).every(([k, v]) => (k === 'com.docker.network.enable_ipv4' && v === 'true') || (k === 'com.docker.network.enable_ipv6' && v === 'false')), 'Owned internal network configuration mismatch');
  const ensureContainer = async (name: string, image: string, networkMode: string, mounts: { source: string; target: string; readOnly: boolean }[], env: string[], command: string[]): Promise<string> => {
    let object = await inspect('container', name);
    if (!object) {
      try { await docker.command(['create', '--name', name, ...labelArgs, ...effectiveRestrictions, '--network', networkMode, ...(image === pins.kestra.image ? ['--hostname', 'sf-kestra', '--add-host', 'sf-kestra:127.0.0.1'] : []), ...mounts.flatMap(m => ['--mount', dockerBind(m.source, m.target, m.readOnly)]), ...env.flatMap(e => ['--env', e]), image, ...command]); }
      catch { /* exact owned config must reconcile, including after a lost create reply */ }
      object = await inspect('container', name);
    }
    check(object, 'Container creation outcome unknown');
    const verifyEffectiveNetworks = (container: any, assigned: boolean): void => {
      const attached = container.NetworkSettings?.Networks;
      check(container.HostConfig?.NetworkMode === networkMode && attached && typeof attached === 'object' && !Array.isArray(attached), 'Container effective network configuration unavailable');
      if (networkMode.startsWith('container:')) {
        // The trusted transport joins the exact engine container namespace; it owns no endpoints.
        check(Object.keys(attached).length === 0, 'Transport effective network attachments mismatch');
      } else {
        const names = Object.keys(attached); const id = attached[networkName]?.NetworkID;
        // Docker may leave a newly created, not-yet-started endpoint's ID empty.
        // Once running, require the actual ID of the verified owned internal network.
        check(names.length === 1 && names[0] === networkName && (id === network.Id || !assigned && id === ''), 'Engine effective network attachments mismatch');
      }
    };
    verifyEffectiveNetworks(object, object.State.Running === true);
    const h = object.HostConfig; const c = object.Config; const base = imageConfigs.get(image);
    check(canonical(c.Entrypoint) === canonical(base.Entrypoint) && c.WorkingDir === base.WorkingDir, 'Container entrypoint configuration mismatch');
    check(object.Name === '/' + name && object.Image === imageIds.get(image) && c.Image === image && c.User === user && Object.entries(labels).every(([k, v]) => c.Labels?.[k] === v) && canonical(c.Cmd) === canonical(command), 'Owned container configuration mismatch');
    check(h.NetworkMode === networkMode && h.ReadonlyRootfs && !h.Privileged && h.CapDrop?.includes('ALL') && !(h.CapAdd?.length) && h.SecurityOpt?.includes('no-new-privileges') && !Object.keys(h.PortBindings ?? {}).length && !(h.Binds?.length) && !h.PidMode && h.PidsLimit === 256 && h.Memory === 2147483648 && h.NanoCpus === 2000000000, 'Container restriction configuration mismatch');
    check(object.Mounts.length === mounts.length && mounts.every(m => object.Mounts.some((a: any) => a.Type === 'bind' && a.Source === m.source && a.Destination === m.target && a.RW === !m.readOnly)), 'Container mount configuration mismatch');
    const envMap = (values: string[]) => Object.fromEntries(values.map(e => { const split = e.indexOf('='); return [e.slice(0, split), e.slice(split + 1)]; }));
    check(canonical(envMap(c.Env ?? [])) === canonical(envMap([...(base.Env ?? []), ...env])), 'Container environment configuration mismatch');
    check(h.IpcMode !== 'host' && h.UsernsMode !== 'host' && h.UTSMode !== 'host' && !(h.Devices?.length) && !(h.DeviceRequests?.length) && !(h.VolumesFrom?.length) && canonical(h.Tmpfs) === canonical({ '/tmp': tmpfs }), 'Container namespace/tmpfs restriction mismatch');
    // Mutating setup adoption always rejoins an existing transport. The engine may have
    // restarted in another invocation, including a crash before sidecar reattachment.
    // Running flags, PIDs and timestamps cannot establish shared namespace freshness.
    if (object.State.Running && image === pins.worker.image) {
      try { await docker.command(['restart', '--timeout', '1', object.Id]); } catch { /* reconcile namespace reattachment */ }
      object = await inspect('container', name); check(object?.State.Running, 'Transport restart outcome unknown');
    }
    if (!object.State.Running) { try { await docker.command(['start', object.Id]); } catch { /* inspect start outcome */ } object = await inspect('container', name); check(object?.State.Running, 'Container start outcome unknown'); }
    verifyEffectiveNetworks(object, true);
    return object.Id;
  };
  const containerId = await ensureContainer(prefix + '-kestra', pins.kestra.image, networkName, [{ source: dataDir, target: '/app/data', readOnly: false }, { source: configDir, target: '/app/confs', readOnly: true }], ['MICRONAUT_CONFIG_FILES=/app/confs/application.yaml', 'KESTRA_PLUGINS_AUTO_INSTALL_ENABLED=false'], ['server', 'local']);
  const transportContainerId = await ensureContainer(prefix + '-transport', pins.worker.image, 'container:' + containerId, [], [], ['node', '-e', 'setInterval(()=>{},1000)']);
  await ensurePrivateContent(join(dir, 'owned-resources.json'), JSON.stringify({ installationId: installation.id, owner, networkId: network.Id, containerId, transportContainerId, images: [pins.kestra.image, pins.worker.image] }));
  const request = createEngineTransport(docker, transportContainerId, secrets);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const r = await request({ method: 'GET', path: '/executions/search?size=1' }); if (r.status === 200) { ready = true; break; } } catch { /* bounded boot observation */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  check(ready, 'Protected Kestra API did not become ready; owned resources retained for reconciliation');
  return { installationId: installation.id, containerId, transportContainerId, journalDirectory, brokerNetwork: { id: network.Id, name: networkName, alias: 'sf-broker', port: 8080 }, request };
}

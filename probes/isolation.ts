import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { ProbeEvidence, ProbeOptions, ProfileSpec, ProfileEvidence } from '../src/contracts/domain.ts';
import { validateContract } from '../src/contracts/schemas.ts';
import { assertLiveScratch, ProbeBlocked, writeEvidence } from './common.ts';
import { OwnedDocker, restrictedArgs, verifyImagePins, images } from './docker.ts';

/** Docker configuration inspection complements (never replaces) active in-boundary probes. */
export function inspectRestrictions(value: any, volumes: { name: string; destination: string; readOnly?: boolean }[], network = 'none'): void {
  const h = value.HostConfig;
  if (value.Config.User !== '1000:1000' || !h.ReadonlyRootfs || h.Privileged || h.NetworkMode !== network ||
      h.PidMode || !['private', ''].includes(h.IpcMode) || !h.CapDrop?.includes('ALL') || h.CapAdd?.length ||
      !h.SecurityOpt?.includes('no-new-privileges') || h.SecurityOpt.some((s: string) => s.includes('unconfined')) ||
      h.Binds?.length || h.Devices?.length || Object.keys(h.PortBindings ?? {}).length) throw new ProbeBlocked('Effective container restrictions do not match the trusted profile');
  const mounts = value.Mounts.filter((m: any) => m.Type !== 'tmpfs');
  if (mounts.length !== volumes.length || mounts.some((m: any) => m.Type !== 'volume' ||
      !volumes.some(v => v.name === m.Name && v.destination === m.Destination && (v.readOnly === undefined || m.RW === !v.readOnly)))) throw new ProbeBlocked('Unexpected host/socket/volume mount');
}

// Only fixed canaries. The script never attempts to read a user's credential stores.
export const workerCanary = String.raw`
const fs = require('node:fs'); const net = require('node:net'); const dns = require('node:dns');
(async () => {
 const results = [];
 const record = (name, passed) => results.push({name, passed});
 const denied = operation => { try { operation(); return false; } catch (e) { return ['EACCES','EPERM','ENOENT','EROFS'].includes(e.code); } };
 fs.writeFileSync('/workspace/positive', 'sf-workspace-canary');
 record('workspace-write-positive-control', fs.readFileSync('/workspace/positive', 'utf8') === 'sf-workspace-canary');
 record('rootfs-write-denied', denied(() => fs.writeFileSync('/etc/sf-p4-canary', 'fixed')));
 record('ungranted-host-canary-denied', denied(() => fs.readFileSync('/host-canary/credential')));
 fs.symlinkSync('/host-canary/credential', '/workspace/escape');
 record('symlink-escape-denied', denied(() => fs.readFileSync('/workspace/escape')));
 record('docker-socket-denied', denied(() => fs.openSync('/var/run/docker.sock','r')));
 record('ungranted-credential-environment-absent', !['GH_TOKEN','GITHUB_TOKEN','AWS_ACCESS_KEY_ID','SF_HOST_CANARY'].some(k => process.env[k]));
 record('declared-model-canary-readable-within-boundary', process.env.SF_DECLARED_MODEL_CANARY === 'sf-model-fixed-canary');
 record('nonroot-no-capabilities-no-new-privileges', process.getuid() === 1000 && /CapEff:\s+0+\n/.test(fs.readFileSync('/proc/self/status','utf8')) && /NoNewPrivs:\s+1/.test(fs.readFileSync('/proc/self/status','utf8')));
 const cannotConnect = (host,port) => new Promise(resolve => { const s=net.connect({host,port}); s.setTimeout(800); s.once('connect',()=>{s.destroy();resolve(false)}); s.once('error',()=>resolve(true)); s.once('timeout',()=>{s.destroy();resolve(true)}); });
 for (const [name,host,port] of [['ipv4-egress-denied','1.1.1.1',443],['ipv6-egress-denied','2606:4700:4700::1111',443],['ipv4-mapped-ipv6-egress-denied','::ffff:1.1.1.1',443],['alternate-dns-tcp-denied','8.8.8.8',53]]) record(name, await cannotConnect(host,port));
 const resolver = new dns.promises.Resolver({timeout:500,tries:1}); resolver.setServers(['1.1.1.1']);
 let dnsBlocked = false; try { await resolver.resolve4('example.com'); } catch { dnsBlocked = true; }
 record('alternate-dns-udp-denied',dnsBlocked);
 console.log(JSON.stringify(results));
})().catch(()=>process.exit(1));`;

/** Missing checks must not be mistaken for a passing denial baseline. */
export function requireWorkerAssertions(results: ProbeEvidence['assertions']): void {
  const required = ['workspace-write-positive-control', 'rootfs-write-denied', 'ungranted-host-canary-denied', 'symlink-escape-denied',
    'docker-socket-denied', 'ungranted-credential-environment-absent', 'declared-model-canary-readable-within-boundary',
    'nonroot-no-capabilities-no-new-privileges', 'ipv4-egress-denied', 'ipv6-egress-denied', 'ipv4-mapped-ipv6-egress-denied',
    'alternate-dns-tcp-denied', 'alternate-dns-udp-denied'];
  if (results.length !== required.length || new Set(results.map(r => r.name)).size !== required.length ||
      results.some(r => !required.includes(r.name) || r.passed !== true)) throw new Error('Worker restriction assertions incomplete or failed');
}
/** No caller-supplied or fixture evidence can mint readiness. Actual native executors are not yet verified. */
export async function verifyProfile(profile: ProfileSpec): Promise<ProfileEvidence> {
  validateContract('ProfileSpec', profile);
  if (profile.ownerId === 'bb') throw new ProbeBlocked('BB native credential boundary blocked: server 0.48.1/SDK 0.6.104 has no per-machine initial GitHub/global environment denial');
  throw new ProbeBlocked('Native boundary unverified: require supported isolated owner, approved model service/credential scope, native lifecycle and all client-contributed tools executing inside that same boundary');
}
export async function probeIsolation(options: ProbeOptions): Promise<ProbeEvidence> {
  validateContract('ProbeOptions', options);
  const report: ProbeEvidence = { name: 'isolation', mode: options.mode, status: 'blocked', versions: {}, assertions: [], artifacts: [] };
  const details: any = { observedAt: new Date().toISOString(), nativeProfiles: [], productionDispatchAllowed: false, credentialScope: 'Fixed canaries only; declared model material may be readable in its approved boundary. No use-only secrecy claim.' };
  if (options.mode === 'fixture') return writeEvidence(options.outputDir, report, { ...details, reason: 'Fixture cannot establish a worker or native boundary' });
  await assertLiveScratch(options);
  const docker = new OwnedDocker(options.outputDir);
  details.resourceOwner = docker.owner;
  try {
    await verifyImagePins(docker);
    report.versions = { docker: await docker.command(['version', '--format', '{{.Server.Version}}']), worker: images.worker.image };
    const hostCanary = await docker.volume('host-canary');
    // Trusted canary setup has a separate mount. No actual host credential location is touched.
    const setup = await docker.run('canary-setup', ['--pull', 'never', '--network', 'none', '--mount', `type=volume,src=${hostCanary},dst=/host-canary`, images.worker.image, 'node', '-e', 'require("fs").writeFileSync("/host-canary/credential","sf-host-fixed-canary");setInterval(()=>{},1000)']);
    const observed = await docker.command(['exec', setup, 'node', '-e', 'console.log(require("fs").readFileSync("/host-canary/credential","utf8")==="sf-host-fixed-canary")']);
    if (observed !== 'true') throw new Error('Host-canary positive control failed');
    const worker = await docker.run('worker', [...restrictedArgs(), '--tmpfs', '/workspace:rw,nosuid,nodev,noexec,uid=1000,gid=1000', '--env', 'SF_DECLARED_MODEL_CANARY=sf-model-fixed-canary', images.worker.image, 'node', '-e', 'setInterval(()=>{},1000)']);
    const effective = await docker.inspect(worker); inspectRestrictions(effective, []);
    const results = JSON.parse(await docker.command(['exec', worker, 'node', '-e', workerCanary]));
    requireWorkerAssertions(results);
    report.assertions.push({ name: 'owned-host-canary-positive-control', passed: true }, { name: 'effective-worker-settings-inspected', passed: true }, ...results);
    details.effectiveSettings = { image: effective.Config.Image, user: effective.Config.User, readOnly: effective.HostConfig.ReadonlyRootfs, network: effective.HostConfig.NetworkMode, capDrop: effective.HostConfig.CapDrop, securityOpt: effective.HostConfig.SecurityOpt, mounts: effective.Mounts.map((m: any) => ({ type: m.Type, destination: m.Destination })) };
    details.workerBoundary = results.every((r: any) => r.passed) ? 'passed' : 'failed';
    report.status = results.every((r: any) => r.passed) ? 'blocked' : 'failed';
    details.blockers = ['Worker process exercised; actual VS Code native owner/model/client-tool boundary was not exercised.', 'BB enrollment forbidden under confirmed initial credential forwarding policy; no native profile exists.'];
  } catch (error) { details.reason = error instanceof ProbeBlocked ? error.message : 'Worker probe failed'; report.status = error instanceof ProbeBlocked ? 'blocked' : 'failed'; }
  finally { try { await docker.cleanup(); details.cleanup = 'complete'; } catch (error) { details.cleanup = (error as Error).message; report.status = 'blocked'; } }
  return writeEvidence(options.outputDir, report, details);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, 'scratch-repo': { type: 'string' }, 'output-dir': { type: 'string', default: 'logs/probes/isolation' } } });
  if (!values['scratch-repo']) throw new Error('Supply --scratch-repo');
  const report = await probeIsolation({ ...(values.live ? { mode: 'live' as const, allowLive: true as const } : { mode: 'fixture' as const, allowLive: false }), scratchRepo: values['scratch-repo'], outputDir: values['output-dir']! });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

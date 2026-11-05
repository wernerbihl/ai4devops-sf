import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Installation, KestraHandle } from '../kestra/deployment.ts';
import { kestraImagePins } from '../kestra/deployment.ts';
import { canonical, ensure, fingerprint } from '../storage/database.ts';
import type { BrokerHttpRequest, BrokerHttpResponse, WorkerBroker } from './server.ts';
import { WORKER_TRANSPORT_MAX_WIRE_BYTES } from '../contracts/worker-transport.ts';
const maxFrame = WORKER_TRANSPORT_MAX_WIRE_BYTES * 2 + 65_536;
/** Dedicated HTTP-to-stdio relay. Host/port are trusted launch configuration, never worker inputs. */
export function createRelaySource(port = 8080, address = '0.0.0.0'): string {
  ensure(Number.isInteger(port) && port >= 0 && port <= 65535 && ['0.0.0.0','127.0.0.1'].includes(address), 'relay_config', 'Invalid relay address');
  return `const http=require('node:http'),crypto=require('node:crypto');
const max=${WORKER_TRANSPORT_MAX_WIRE_BYTES},frameMax=${maxFrame},pending=new Map();let buffer='',serial=Promise.resolve();
const send=v=>{serial=serial.then(()=>new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(v)+'\\n',e=>e?reject(e):resolve()))).catch(()=>process.exit(1));};
const server=http.createServer(async(q,s)=>{if(pending.size>=8){s.writeHead(503).end();q.resume();return;}const id=crypto.randomUUID();
const timer=setTimeout(()=>{pending.delete(id);s.writeHead(504).end();},30000);pending.set(id,{s,timer});let body='',size=0;
try{q.setEncoding('utf8');for await(const chunk of q){size+=Buffer.byteLength(chunk);if(size>max)throw Error();body+=chunk;}
if((q.url||'').length>2048||typeof q.headers.authorization!=='string'||q.headers.authorization.length>512)throw Error();
send({id,method:q.method,path:q.url,authorization:q.headers.authorization,body});}catch{clearTimeout(timer);pending.delete(id);if(!s.headersSent)s.writeHead(400).end();}});
server.requestTimeout=30000;server.headersTimeout=10000;server.maxHeadersCount=32;
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>frameMax)process.exit(1);
let end;while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const v=JSON.parse(line);const p=pending.get(v.id);
if(!p)continue;if(!Number.isInteger(v.status)||v.status<200||v.status>599||typeof v.body!=='string'||Buffer.byteLength(v.body)>max)throw Error();
clearTimeout(p.timer);pending.delete(v.id);p.s.writeHead(v.status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(v.body);}catch{process.exit(1);}}});
process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(1));process.stdout.on('error',()=>process.exit(1));
server.listen(${port},${JSON.stringify(address)},()=>send({type:'ready',port:server.address().port}));`;
}
export const relaySource = createRelaySource();
export interface RelayProcess { stdin: Writable; stdout: Readable; close(): void }
export interface StreamingDocker { open(args: string[]): RelayProcess }
export class ProcessStreamingDocker implements StreamingDocker {
  readonly executable: string;
  constructor(executable = 'docker') { this.executable = executable; }
  open(args: string[]): RelayProcess {
    const child = spawn(this.executable, args, { shell: false, stdio: ['pipe','pipe','pipe'] });
    child.stderr.resume(); child.on('error', () => child.stdout.destroy());
    return { stdin: child.stdin, stdout: child.stdout, close: () => { child.stdin.end(); child.kill(); } };
  }
}
/** Bounded protocol, no logs or credential-bearing argv. Disconnect leaves durable native intents uncertain. */
export function serveRelay(process: RelayProcess, handler: (request: BrokerHttpRequest) => Promise<BrokerHttpResponse>) {
  let buffer = ''; let closed = false; let output = Promise.resolve(); const inflight = new Set<string>();
  let acceptReady!: (port: number) => void; let rejectReady!: (error: Error) => void; let readySeen = false;
  const ready = new Promise<number>((resolve,reject) => { acceptReady = resolve; rejectReady = reject; });
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); if (!readySeen) rejectReady(new Error('Private relay did not become ready')); process.close(); };
  const timer = setTimeout(close, 30_000); timer.unref();
  process.stdin.on('error', close); process.stdout.on('error', close); process.stdout.on('end', close);
  process.stdout.setEncoding('utf8');
  process.stdout.on('data', (chunk: string) => {
    if (closed) return; buffer += chunk; if (Buffer.byteLength(buffer) > maxFrame) { close(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'ready' && Number.isInteger(frame.port) && !readySeen) { readySeen = true; clearTimeout(timer); acceptReady(frame.port); continue; }
        ensure(readySeen, 'relay_frame', 'Relay handshake required');
        ensure(typeof frame.id === 'string' && /^[a-f\d-]{36}$/.test(frame.id) && !inflight.has(frame.id) && inflight.size < 8
          && typeof frame.method === 'string' && typeof frame.path === 'string' && frame.path.length <= 2048
          && typeof frame.authorization === 'string' && frame.authorization.length <= 512 && typeof frame.body === 'string'
          && Buffer.byteLength(frame.body) <= WORKER_TRANSPORT_MAX_WIRE_BYTES, 'relay_frame', 'Invalid relay frame');
        inflight.add(frame.id);
        void handler(frame).then(reply => {
          if (closed) return;
          ensure(Buffer.byteLength(reply.body) <= WORKER_TRANSPORT_MAX_WIRE_BYTES, 'relay_frame', 'Response exceeds bound');
          output = output.then(() => new Promise<void>((resolve,reject) => process.stdin.write(JSON.stringify({ id: frame.id, ...reply })+'\n', e => e ? reject(e) : resolve())));
          return output;
        }).catch(close).finally(() => inflight.delete(frame.id));
      } catch { close(); return; }
    }
  });
  return { close, ready };
}
/** Concrete cross-platform bridge: Docker argv/stdin only, no host binds, ports, sockets or credentials. */
export async function startPrivateBrokerBridge(options: { installation: Installation; kestra: KestraHandle; broker: WorkerBroker; streaming?: StreamingDocker }) {
  const { installation, kestra, broker } = options; const docker = installation.docker;
  ensure(installation.id === kestra.installationId, 'bridge_owner', 'Installation mismatch');
  const network = JSON.parse(await docker.command(['network','inspect',kestra.brokerNetwork.id]))[0];
  ensure(network?.Id === kestra.brokerNetwork.id && network.Name === kestra.brokerNetwork.name && network.Internal === true && network.Driver === 'bridge'
    && network.Labels?.['sf.installation'] === installation.id, 'bridge_network', 'Owned internal engine network required');
  const name = 'sf-broker-' + fingerprint({ installation: installation.id, network: network.Id }).slice(0,24);
  const image = kestraImagePins.worker.image; const inspectedImage = JSON.parse(await docker.command(['image','inspect',image]))[0];
  ensure(inspectedImage?.RepoDigests?.includes(image) && inspectedImage.Os === 'linux' && inspectedImage.Architecture === 'amd64', 'bridge_image', 'Pinned relay image required');
  const labels = { 'sf.installation': installation.id, 'sf.component': 'attempt-broker', 'sf.network': network.Id };
  const command = ['node','-e','setInterval(()=>{},2147483647)'];
  const listed = (await docker.command(['container','ls','--all','--filter',`name=^${name}$`,'--format','{{.ID}}'])).trim();
  if (!listed) {
    try { await docker.command(['create','--name',name,'--pull','never','--platform','linux/amd64','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','256m','--cpus','1','--network',network.Id,'--network-alias','sf-broker',...Object.entries(labels).flatMap(([k,v])=>['--label',`${k}=${v}`]),image,...command]); }
    catch { /* deterministic owned name; inspect uncertain creation, never blind recreate */ }
  }
  async function inspect() {
    const c = JSON.parse(await docker.command(['container','inspect',name]))[0]; const h = c?.HostConfig; const nets = c?.NetworkSettings?.Networks;
    ensure(c && c.Image === inspectedImage.Id && c.Config?.Image === image && c.Config.User === '1000:1000'
      && canonical(c.Config.Cmd) === canonical(command) && canonical(c.Config.Entrypoint ?? null) === canonical(inspectedImage.Config.Entrypoint ?? null)
      && Object.entries(labels).every(([k,v])=>c.Config.Labels?.[k]===v) && h?.ReadonlyRootfs && !h.Privileged
      && canonical(h.CapDrop) === canonical(['ALL']) && !h.CapAdd?.length && h.SecurityOpt?.includes('no-new-privileges')
      && canonical(c.Config.Env ?? []) === canonical(inspectedImage.Config.Env ?? [])
      && !h.DeviceRequests?.length && !h.ExtraHosts?.length && !h.Dns?.length && !h.Links?.length && !h.VolumesFrom?.length && !Object.keys(h.Sysctls ?? {}).length
      && canonical(h.SecurityOpt) === canonical(['no-new-privileges']) && h.NetworkMode === network.Id && !h.PidMode && (!h.IpcMode || h.IpcMode === 'private') && !h.Devices?.length
      && !Object.keys(h.PortBindings ?? {}).length && !c.Mounts?.length && !h.Binds?.length && h.PidsLimit === 64
      && h.Memory === 256*1024*1024 && h.NanoCpus === 1e9 && nets && Object.keys(nets).length === 1
      && Object.entries(nets).every(([name,n]: [string,any])=>name === network.Name && (n.NetworkID === network.Id || (!c.State?.Running && n.NetworkID === '')) && n.Aliases?.includes('sf-broker')), 'bridge_changed', 'Effective broker relay configuration changed');
    const liveNet = JSON.parse(await docker.command(['network','inspect',network.Id]))[0];
    ensure(liveNet.Id === network.Id && liveNet.Internal === true && liveNet.Driver === 'bridge' && liveNet.Labels?.['sf.installation'] === installation.id
      && Object.keys(liveNet.Containers ?? {}).every(id => [c.Id, kestra.containerId, kestra.transportContainerId].includes(id)), 'bridge_network', 'Untrusted peer on engine network');
    return c;
  }
  let container = await inspect();
  if (!container.State?.Running) { await docker.command(['start',name]); container = await inspect(); }
  ensure(container.State.Running, 'bridge_stopped', 'Broker relay is not running');
  const process = (options.streaming ?? new ProcessStreamingDocker()).open(['exec','-i',container.Id,'node','-e',relaySource]);
  const session = serveRelay(process, async request => { await inspect(); return broker.handle(request); });
  await session.ready;
  // Unique host-side session ID only; no credentials in labels, argv or output.
  return { containerId: container.Id as string, sessionId: randomUUID(), close: session.close };
}

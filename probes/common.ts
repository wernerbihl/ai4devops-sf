import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { ProbeEvidence, ProbeOptions } from '../src/contracts/domain.ts';
import { validateContract } from '../src/contracts/schemas.ts';

export class ProbeBlocked extends Error {}
const exec = promisify(execFile);

/** Never persist wire payloads, endpoint tokens, prompts, or provider credentials. */
export async function writeEvidence(outputDir: string, report: ProbeEvidence, details: object): Promise<ProbeEvidence> {
  await mkdir(outputDir, { recursive: true });
  const artifact = join(outputDir, `${report.name}.json`);
  report.artifacts = [artifact, join(outputDir, `${report.name}-details.json`)];
  validateContract('ProbeEvidence', report);
  await writeFile(report.artifacts[1]!, `${JSON.stringify(details, null, 2)}\n`, { mode: 0o600 });
  await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

export async function assertLiveScratch(options: ProbeOptions): Promise<void> {
  const path = await realpath(options.scratchRepo);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const scratchRoot = await realpath(join(projectRoot, 'tests', '.scratch'));
  if (!path.startsWith(`${scratchRoot}${sep}`)) throw new ProbeBlocked('Live repository must be inside ignored tests/.scratch');
  const git = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel']);
  if (await realpath(git.stdout.trim()) !== path) throw new ProbeBlocked('Live scratch must be an independent git repository');
  const ignored = await exec('git', ['-C', projectRoot, 'check-ignore', path]);
  if (!ignored.stdout.trim()) throw new ProbeBlocked('Live scratch must be ignored');
  const status = await exec('git', ['-C', path, 'status', '--porcelain', '--untracked-files=all']);
  const files = await exec('git', ['-C', path, 'ls-files']);
  if (status.stdout.trim() || files.stdout.trim() !== 'README.md') throw new ProbeBlocked('Live scratch must be clean and contain only the diagnostic README.md');
  const readme = await readFile(join(path, 'README.md'), 'utf8');
  if (readme !== '# Native lifecycle probe\n\nTrusted no-tool diagnostic.\n') throw new ProbeBlocked('Unexpected scratch content');
}

/** Registry entries are host-owned local IPC credentials, never provider credential files. */
export async function discoverEndpoint(overrideUserData?: string): Promise<string> {
  const userData = overrideUserData ?? (process.platform === 'win32'
    ? join(process.env.APPDATA ?? '', 'Code - Insiders')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code - Insiders'));
  let entries: string[];
  const root = join(userData, 'agent-host', 'local-endpoint', 'entries');
  try { entries = (await readdir(root)).filter(f => f.endsWith('.json')); }
  catch { throw new ProbeBlocked('No local native AHP endpoint; run the probe in the owning host OS or pass --endpoint'); }
  const live: string[] = [];
  for (const file of entries) {
    try {
      const entry = JSON.parse(await readFile(join(root, file), 'utf8'));
      if (entry.schemaVersion !== 2 || entry.type !== 'editor' || !Number.isInteger(entry.pid)) continue;
      try { process.kill(entry.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; }
      live.push(file);
    } catch { /* Ignore malformed registry entries individually. */ }
  }
  if (live.length !== 1) throw new ProbeBlocked('Select an explicit native endpoint registry entry; zero or multiple hosts found');
  return join(root, live[0]!);
}

/** WebSocket framing over the exact published pipe/socket, or an explicit loopback endpoint. */
export async function connectEndpoint(endpoint: string): Promise<AhpTransport> {
  let ws: WebSocket;
  if (endpoint.startsWith('ws:')) {
    const url = new URL(endpoint);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new ProbeBlocked('Probe endpoint must be local');
    ws = new WebSocket(url, { handshakeTimeout: 5_000 });
  } else {
    const entry = JSON.parse(await readFile(endpoint, 'utf8'));
    if (entry.schemaVersion !== 2 || entry.type !== 'editor' || typeof entry.connectionToken !== 'string') {
      throw new ProbeBlocked('Expected schema-2 editor-owned native endpoint');
    }
    if (entry.endpoint?.type === 'socket' && typeof entry.endpoint.path === 'string') {
      if (entry.endpoint.path.startsWith('\\\\') && process.platform !== 'win32') throw new ProbeBlocked('Windows native pipe requires a Windows helper');
      ws = new WebSocket(`ws://localhost/?tkn=${encodeURIComponent(entry.connectionToken)}`, {
        createConnection: () => connect({ path: entry.endpoint.path }), handshakeTimeout: 5_000,
      });
    } else if (entry.endpoint?.type === 'tcp' && ['localhost', '127.0.0.1', '::1'].includes(entry.endpoint.host) && Number.isInteger(entry.endpoint.port)) {
      const host = entry.endpoint.host === '::1' ? '[::1]' : entry.endpoint.host;
      ws = new WebSocket(`ws://${host}:${entry.endpoint.port}/?tkn=${encodeURIComponent(entry.connectionToken)}`, { handshakeTimeout: 5_000 });
    } else throw new ProbeBlocked('Unsupported endpoint metadata');
  }
  const queue: (TransportFrame | null)[] = [];
  let pending: ((frame: TransportFrame | null) => void) | undefined;
  let closed = false;
  const deliver = (frame: TransportFrame | null) => {
    if (pending) { const resolve = pending; pending = undefined; resolve(frame); }
    else queue.push(frame);
  };
  ws.on('message', data => deliver({ kind: 'text', text: data.toString() }));
  ws.on('close', () => { closed = true; deliver(null); });
  // Avoid exposing token-bearing connection errors. The initialize deadline bounds post-open failures.
  ws.on('error', () => { closed = true; deliver(null); });
  try { await once(ws, 'open'); }
  catch { ws.terminate(); throw new ProbeBlocked('Native AHP endpoint unavailable or IPC authentication rejected'); }
  return {
    send(message: JsonRpcMessage | string) {
      if (closed) throw new ProbeBlocked('Native transport closed');
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    },
    async recv() {
      if (queue.length) return queue.shift()!;
      if (closed) return null;
      return new Promise(resolve => { pending = resolve; });
    },
    close() { ws.terminate(); },
  };
}

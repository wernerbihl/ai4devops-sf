// Narrow Windows IPC bridge. Stage only this file and pinned ws in an owned Windows temp directory.
// Endpoint admission tokens stay inside this process; wire frames use private stdio, never logs.
import { createInterface } from 'node:readline';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
try {
  const registry = join(process.env.APPDATA, 'Code - Insiders', 'agent-host', 'local-endpoint', 'entries');
  const files = (await readdir(registry)).filter(f => f.endsWith('.json'));
  const live = [];
  for (const file of files) {
    try {
      const entry = JSON.parse(await readFile(join(registry, file), 'utf8'));
      if (entry.schemaVersion !== 2 || entry.type !== 'editor' || !Number.isInteger(entry.pid)) continue;
      try { process.kill(entry.pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; }
      live.push(entry);
    } catch { /* Ignore malformed entries individually. */ }
  }
  if (live.length !== 1) throw Object.assign(new Error(), { code: 'AMBIGUOUS_NATIVE_ENDPOINT' });
  const entry = live[0];
  if (entry.schemaVersion !== 2 || entry.type !== 'editor' || entry.endpoint?.type !== 'socket'
    || typeof entry.endpoint.path !== 'string' || typeof entry.connectionToken !== 'string') throw new Error('Unsupported endpoint');
  const ws = new WebSocket(`ws://localhost/?tkn=${encodeURIComponent(entry.connectionToken)}`, {
    createConnection: () => connect({ path: entry.endpoint.path }), handshakeTimeout: 5_000,
  });
  ws.on('error', () => {});
  await once(ws, 'open');
  process.stderr.write(`SF_NATIVE_HELPER_READY ${process.version}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => ws.send(line));
  lines.on('close', () => ws.terminate());
  ws.on('message', data => process.stdout.write(`${data.toString()}\n`));
  ws.on('close', () => { lines.close(); });
} catch (error) {
  const code = typeof error.code === 'string' && /^[A-Z_0-9]+$/.test(error.code) ? error.code : 'HELPER_STARTUP';
  process.stderr.write(`SF_NATIVE_HELPER_ERROR ${code}\n`);
  process.exitCode = 2;
}

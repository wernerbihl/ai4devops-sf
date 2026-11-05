import { join } from 'node:path';
import { readPrivateFile, readVaultSecret } from '../service/config.ts';

/** Sends one request only. A lost reply is uncertain and must not be retried blindly. */
export async function requestNext(root: string, key: string): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new Error('A stable dispatch key is required');
  const control = JSON.parse(readPrivateFile(join(root, 'control.json')).toString()) as { schemaVersion?: unknown; url?: unknown };
  if (control.schemaVersion !== 1 || typeof control.url !== 'string') throw new Error('Invalid private controller address');
  const url = new URL(control.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid private controller address');
  const secret = readVaultSecret(root, 'private-control');
  if (secret.length < 32) throw new Error('Invalid private controller key');
  const response = await fetch(new URL('/next', url), {
    method: 'POST', headers: { authorization: `Bearer ${secret.toString('base64url')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ key }), redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Private dispatch was not confirmed; inspect retained actions before retrying');
  return response.json();
}

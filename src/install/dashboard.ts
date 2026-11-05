import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Installation } from './locator.ts';
import { readPrivateFile, readVaultSecret } from '../service/config.ts';
import { loadOwnedService } from './owned-service.ts';
import { probeController } from '../cli/next.ts';
import { acquireAdministrationLock, assertNoPendingStart, assertNoPendingReconfiguration, assertNoUninstall, recordServiceStart } from './administration.ts';
import type { DashboardPair } from './dashboard-host.ts';
/** OS-user/private host only; no browser route mints pairing tokens. */
export async function requestDashboardPair(root: string, origin?: string): Promise<DashboardPair> {
  const control = JSON.parse(readPrivateFile(join(root, 'control.json')).toString());
  const url = new URL(control.url);
  if (control.schemaVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Invalid private controller');
  const secret = readVaultSecret(root, 'private-control'); if (secret.length < 32) throw Error('Invalid protected control key');
  const response = await fetch(new URL('/pair', url), { method: 'POST', headers: { authorization: `Bearer ${secret.toString('base64url')}`, 'content-type': 'application/json' }, body: JSON.stringify(origin ? { origin } : {}), redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Dashboard pairing unavailable; reopen setup after the installed service is ready');
  const value = await response.json() as DashboardPair; const api = new URL(value.apiUrl);
  if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || !api.port || api.pathname !== '/' || api.username || api.password || api.search || api.hash || typeof value.origin !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 60_000) throw Error('Invalid dashboard pairing response');
  return value;
}
export async function launchDashboard(url: string): Promise<void> {
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  // Never shell-interpolate a proof; no reusable credential is placed in this short-lived URL.
  await new Promise<void>((resolve, reject) => { const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Dashboard launcher unavailable; run setup again from your desktop session'))); });
}
/** Existing setup's reopen/repair path starts only the existing registered service. */
export async function openInstalledDashboard(installation: Installation, options: { systemctl?: string; adminDirectory?: string; launch?: (url: string) => Promise<void> } = {}): Promise<void> {
  const lock = await acquireAdministrationLock(installation.id, options.adminDirectory);
  try {
    await assertNoUninstall(installation.root); await assertNoPendingReconfiguration(installation.root, installation.id, options.adminDirectory); await assertNoPendingStart(installation.root, installation.id, options.adminDirectory);
    const service = await loadOwnedService(installation, options); const start = await service.status() === 'stopped';
    if (start) { await recordServiceStart(installation.root, installation.id, 'pending', options.adminDirectory); await service.start(); }
    let available = false; for (let i = 0; i < 30; i++) { try { await probeController(installation.root); available = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); } }
    if (!available) throw Error('Installed service unavailable; inspect retained installation resources');
    if (start) await recordServiceStart(installation.root, installation.id, 'complete', options.adminDirectory);
    const proof = await requestDashboardPair(installation.root);
    if (proof.origin !== new URL(proof.apiUrl).origin) throw Error('Standalone dashboard needs the configured API origin');
    await (options.launch ?? launchDashboard)(`${proof.apiUrl}/dashboard/${randomUUID()}#sf_pair=${encodeURIComponent(proof.token)}`);
  } finally { lock.close(); }
}

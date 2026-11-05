import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
export interface DashboardAssetManifest { schemaVersion: 1; version: string; files: Record<string, string>; protocolSha256: string; sourceSha256: string }
/** A generated explicit asset map: no arbitrary filesystem route, remote scripts or global host reset. */
export function createDashboardAssets(root: string): (req: IncomingMessage, res: ServerResponse) => boolean {
  const canonical = realpathSync(root);
  const manifest = JSON.parse(readFileSync(join(canonical, 'provenance.json'), 'utf8')) as DashboardAssetManifest;
  const types: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'factory-ui.js': 'text/javascript', 'factory-ui.css': 'text/css', 'standalone.js': 'text/javascript' };
  if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+/.test(manifest.version) || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) || !/^[a-f0-9]{64}$/.test(manifest.protocolSha256)) throw Error('Incompatible dashboard distribution');
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  for (const [name, type] of Object.entries(types)) {
    const path = join(canonical, name); if (realpathSync(path) !== path) throw Error('Dashboard symlink refused');
    const bytes = readFileSync(path); if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]) throw Error('Dashboard distribution hash mismatch');
    assets.set(name === 'index.html' ? '/dashboard' : '/factory/' + name, { bytes, type });
  }
  return (req, res) => {
    if (req.method !== 'GET') return false;
    const route = req.url ?? '';
    const asset = assets.get(/^\/dashboard\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(route) ? '/dashboard' : route); if (!asset) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site' && (route === '/dashboard' || route.startsWith('/dashboard/'))) { res.writeHead(403).end(); return true; }
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(asset.bytes); return true;
  };
}

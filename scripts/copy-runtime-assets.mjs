import { createHash } from 'node:crypto';
import { cpSync, readFileSync, readdirSync } from 'node:fs';

const dashboardRoot = new URL('../release/dashboard/', import.meta.url);
const dashboardManifest = JSON.parse(readFileSync(new URL('provenance.json', dashboardRoot), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const allowlist = ['canvas.html','canvas.js','channel.js','factory-ui.css','factory-ui.js','index.html','openapi.json','standalone.js'];
if (dashboardManifest.schemaVersion !== 1 || dashboardManifest.version !== JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || Object.keys(dashboardManifest.files).sort().join(',') !== allowlist.sort().join(',') || readdirSync(dashboardRoot).sort().join(',') !== [...allowlist,'provenance.json'].sort().join(',')) throw Error('Incompatible embedded dashboard distribution');
for (const name of allowlist) if (hash(readFileSync(new URL(name, dashboardRoot))) !== dashboardManifest.files[name]) throw Error('Embedded dashboard content hash mismatch: ' + name);
if (hash(readFileSync(new URL('../protocol/openapi.json', import.meta.url))) !== dashboardManifest.protocolSha256) throw Error('Embedded dashboard protocol mismatch; explicitly sync a compatible Canvas distribution');

// Runtime assets only; no probes, developer caches or sibling checkouts in the compiled product.
cpSync(new URL('../src/storage/migrations/', import.meta.url), new URL('../dist/storage/migrations/', import.meta.url), { recursive: true });
cpSync(new URL('../recipes/starter/', import.meta.url), new URL('../dist/recipes/starter/', import.meta.url), { recursive: true });
cpSync(new URL('../runtime/kestra/', import.meta.url), new URL('../dist/runtime/kestra/', import.meta.url), { recursive: true });
cpSync(new URL('../release/images.json', import.meta.url), new URL('../dist/runtime/kestra/images.json', import.meta.url));

cpSync(new URL('../runtime/model-proxy/', import.meta.url), new URL('../dist/runtime/model-proxy/', import.meta.url), { recursive: true });
cpSync(new URL('../runtime/vscode-companion/', import.meta.url), new URL('../dist/runtime/vscode-companion/', import.meta.url), { recursive: true });

const { verifyCompanionPackage } = await import('../dist/install/companion-package.js');
verifyCompanionPackage();

cpSync(new URL('../release/dashboard/', import.meta.url), new URL('../dist/runtime/dashboard/', import.meta.url), { recursive: true });
cpSync(new URL('../protocol/openapi.json', import.meta.url), new URL('../dist/runtime/dashboard/openapi.json', import.meta.url));

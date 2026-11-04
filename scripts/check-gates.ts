import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateContract } from '../src/contracts/schemas.ts';

export interface GateSummary { ready: boolean; blocked: string[]; passed: string[] }
const nativeAssertions = ['provider-schema-discovery', 'create', 'native-open', 'send-input', 'pause', 'resume', 'restart-reconcile', 'quiescence', 'continuous-tool-audit', 'exact-input-answer'];
const dashboardAssertions = ['dom-mounted', 'unmount-clean', 'theme-light', 'theme-dark', 'portal-contained', 'csp-behavior-observed', 'resources-loaded', 'authenticated-health', 'credentials-absent-from-ui', 'native-selection-observed'];
export const isolationAssertions = ['native-execution-in-boundary', 'workspace-write-positive-control', 'ungranted-host-canary-denied', 'symlink-escape-denied', 'docker-socket-denied', 'ungranted-credential-environment-absent', 'ungranted-tool-denied', 'ipv4-egress-denied', 'ipv6-egress-denied', 'ipv4-mapped-ipv6-egress-denied', 'alternate-dns-tcp-denied', 'alternate-dns-udp-denied', 'effective-worker-settings-inspected', 'native-reconnect-same-boundary'];
const vscode = { host: '1.145.0-insider', hostCommit: '3c0ec3a089398503a462029e7cc2a5749df5169a', ahpPackage: '1.0.0', protocol: '1.0.0' };
const bb = { bb: '0.48.1', sdk: '0.6.104' };
/** Reviewed version baseline. Copilot App target is deliberately unresolved until observed. */
export const requirements: Record<string, { versions: Record<string, string>; assertions: string[] }> = {
  'vscode-copilot': { versions: vscode, assertions: nativeAssertions },
  'vscode-codex': { versions: vscode, assertions: nativeAssertions },
  'bb-codex-isolated': { versions: bb, assertions: ['verified-native-isolation', ...nativeAssertions.slice(1), ...isolationAssertions] },
  'kestra-oss-h2': { versions: { docker: '29.7.2', kestra: 'kestra/kestra@sha256:d7bb1af55f4b5730247e5c8c852e2c912ccd36a58c7846ac96d2d749295ba365', worker: 'node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c' }, assertions: ['variables.sf-accepted-unchanged', 'immutable-revision-lookup', 'rf3-lost-start-reply-single-execution', 'h2-pause-survives-restart', 'invalid-typed-resume-rejected', 'typed-resume-output-exact', 'same-execution-after-resume', 'h2-success-survives-second-restart'] },
  'dashboard-standalone': { versions: { node: '24.22.2', svelte: '5.57.3', vite: '8.3.5' }, assertions: [...dashboardAssertions, 'csp-inline-refused'] },
  'dashboard-vscode': { versions: { ...vscode, svelte: '5.57.3' }, assertions: dashboardAssertions },
  'dashboard-copilot-app': { versions: { copilotApp: 'UNRESOLVED', svelte: '5.57.3' }, assertions: dashboardAssertions },
  'dashboard-bb': { versions: { ...bb, svelte: '5.57.3' }, assertions: dashboardAssertions },
};
interface Entry { id: string; file: string; source: string; observedAt: string; sha256: string }
interface Manifest { schemaVersion: 1; evidence: Entry[]; profiles: { specFile: string; evidenceFile: string; source: string; specSha256: string; evidenceSha256: string }[] }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function string(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function contained(root: string, path: string): string {
  if (!string(path) || isAbsolute(path)) throw Error('Expected relative evidence path');
  const candidate = realpathSync(resolve(root, path));
  const rel = relative(realpathSync(root), candidate);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw Error('Evidence escapes selected directory');
  return candidate;
}
function digest(root: string, file: string): string { return createHash('sha256').update(readFileSync(contained(root, file))).digest('hex'); }
function read(root: string, file: string): unknown { return JSON.parse(readFileSync(contained(root, file), 'utf8')); }
function validEvidence(root: string, data: unknown, id: string, requirement: { versions: Record<string, string>; assertions: string[] }): boolean {
  try {
    const evidence = validateContract('VerifiedProbeEvidence', data);
    if (evidence.name !== id || Object.entries(requirement.versions).some(([key, version]) => version === 'UNRESOLVED' || evidence.versions[key] !== version)) return false;
    const names = evidence.assertions.map(a => a.name);
    if (new Set(names).size !== names.length || requirement.assertions.some(a => !names.includes(a))) return false;
    return evidence.artifacts.every(path => statSync(contained(root, path)).isFile());
  } catch { return false; }
}
/** Explicit manifest selection only: historical and duplicate receipts never win by directory order. */
export function checkGates(evidenceDir: string): GateSummary {
  const passed: string[] = []; const blocked: string[] = [];
  let manifest: Manifest;
  try {
    const value = read(evidenceDir, 'manifest.json');
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.evidence) || !Array.isArray(value.profiles)) throw Error('Invalid manifest');
    manifest = value as unknown as Manifest;
  } catch { return { ready: false, blocked: [...Object.keys(requirements), 'manifest', 'provider-copilot', 'provider-codex', 'profile-bb-codex'], passed }; }
  for (const [id, requirement] of Object.entries(requirements)) {
    const entries = manifest.evidence.filter(e => record(e) && e.id === id);
    let ok = false;
    try {
      const entry = entries[0];
      ok = entries.length === 1 && !!entry && string(entry.source) && entry.sha256 === digest(evidenceDir, entry.file) && string(entry.observedAt) && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(entry.observedAt) && Number.isFinite(Date.parse(entry.observedAt)) && validEvidence(evidenceDir, read(evidenceDir, entry.file), id, requirement);
    } catch { /* missing, malformed and unsafe paths fail closed */ }
    (ok ? passed : blocked).push(id);
  }
  const coverage: { id: string; providerId: string; bbCodex: boolean }[] = []; const profileIds = new Set<string>();
  for (const [index, entry] of manifest.profiles.entries()) {
    let id = `profile-invalid-${index}`;
    try {
      if (!record(entry) || !string(entry.source)) throw Error('Missing provenance');
      if (entry.specSha256 !== digest(evidenceDir, entry.specFile) || entry.evidenceSha256 !== digest(evidenceDir, entry.evidenceFile)) throw Error('Profile provenance hash mismatch');
      const spec = validateContract('ProfileSpec', read(evidenceDir, entry.specFile)); id = `profile-${spec.id}`;
      const proof = validateContract('ProfileEvidence', read(evidenceDir, entry.evidenceFile));
      if (profileIds.has(spec.id)) throw Error('Duplicate profile'); profileIds.add(spec.id);
      if (!['vscode:copilot', 'vscode:codex', 'bb:codex'].includes(`${spec.ownerId}:${spec.providerId}`)) throw Error('Unestablished owner/provider');
      const baseline = spec.ownerId === 'bb' ? bb : vscode;
      if (spec.id !== proof.profileId || spec.ownerId !== proof.ownerId || spec.providerId !== proof.providerId || !isDeepStrictEqual(spec.required, proof.required)) throw Error('Profile identity/capabilities mismatch');
      const probeNames = proof.probes.map(probe => probe.name);
      const assertionNames = new Set(proof.probes.flatMap(probe => probe.assertions.map(assertion => assertion.name)));
      if (new Set(probeNames).size !== probeNames.length || isolationAssertions.some(assertion => !assertionNames.has(assertion)) ||
        !proof.probes.every(probe => validEvidence(evidenceDir, probe, probe.name, { versions: { ...baseline, profile: spec.version, image: spec.image }, assertions: [] }))) throw Error('Incomplete or ambiguous native restriction proof');
      passed.push(id); coverage.push({ id, providerId: spec.providerId, bbCodex: spec.ownerId === 'bb' && spec.providerId === 'codex' });
    } catch { blocked.push(id); }
  }
  const accepted = coverage.filter(profile => !blocked.includes(profile.id));
  const providers = new Set(accepted.map(profile => profile.providerId));
  const bbCodex = accepted.some(profile => profile.bbCodex);
  for (const provider of ['copilot', 'codex']) (providers.has(provider) ? passed : blocked).push(`provider-${provider}`);
  (bbCodex ? passed : blocked).push('profile-bb-codex');
  return { ready: blocked.length === 0, blocked: [...new Set(blocked)], passed: [...new Set(passed)].filter(id => !blocked.includes(id)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../release/evidence/p5');
  const result = checkGates(dir); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ready ? 0 : 1;
}

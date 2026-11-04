import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeEvidence, ProbeOptions } from '../src/contracts/domain.ts';
import { assertLiveScratch, ProbeBlocked, writeEvidence } from './common.ts';
const exec = promisify(execFile);

/** Public plugin RPC through bb's authenticated CLI; no token or credential files are read. */
export async function inspectBb(pluginId = 'sf-native-probe'): Promise<unknown> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pluginId)) throw new ProbeBlocked('Expected a BB plugin ID');
  try {
    const response = await exec('bb', ['plugin', 'rpc', 'call', pluginId, 'inspect', '--json'], { timeout: 15_000, maxBuffer: 128 * 1024 });
    return summarizeBbInspection(JSON.parse(response.stdout));
  } catch { throw new ProbeBlocked('BB probe plugin unavailable; build and install bb-plugin-sf-native-probe, then retry'); }
}

export async function probeBb(options: ProbeOptions): Promise<ProbeEvidence> {
  const report: ProbeEvidence = { name: 'bb-codex-isolated', mode: options.mode, status: 'blocked', versions: { runnerNode: process.versions.node }, assertions: [], artifacts: [] };
  let reason = 'Fixture diagnostics cannot satisfy native isolation; run canvas fake-SDK tests separately and use --live for the feasibility gate.';
  let diagnostic: unknown = null;
  try {
    if (options.mode === 'live') {
      if (!options.allowLive) throw new ProbeBlocked('Live mode needs explicit allowLive authorization');
      if (options.provider && options.provider !== 'codex') throw new ProbeBlocked('BB probe advertises only Codex; unregistered Copilot is unsupported');
      await assertLiveScratch(options);
      diagnostic = await inspectBb(options.endpoint);
      // This revision implements a diagnostic protocol, not an attestation protocol. Fail closed even if a remote response claims success.
      reason = 'BLOCKED: SDK 0.6.104 has no per-machine deny policy for initial GitHub/global environment delivery. Native lifecycle and isolation remain unverified; see task-3-report.md.';
    }
  } catch (error) { reason = error instanceof ProbeBlocked ? error.message : 'BB probe failed before native isolation could be verified'; }
  report.assertions = [{ name: 'verified-native-isolation', passed: false }];
  return writeEvidence(options.outputDir, report, { reason, diagnostic, productionDispatchAllowed: false });
}


/** Evidence includes bounded diagnostic facts only, never arbitrary RPC payloads or remote error text. */
export function summarizeBbInspection(value: unknown): object {
  if (!value || typeof value !== 'object') throw new ProbeBlocked('Invalid BB probe inspection response');
  const v = value as Record<string, unknown>;
  const access = v.access && typeof v.access === 'object' ? v.access as Record<string, unknown> : {};
  if (v.sdkVersion !== '0.6.104' || !Array.isArray(v.providers) || !Array.isArray(v.machines) || !Array.isArray(v.machineProviders)) throw new ProbeBlocked('Incompatible BB probe inspection response');
  const forwarding = v.credentialForwarding && typeof v.credentialForwarding === 'object' ? v.credentialForwarding as Record<string, unknown> : {};
  const bootstrap = v.bootstrapSummary && typeof v.bootstrapSummary === 'object' ? v.bootstrapSummary as Record<string, unknown> : {};
  return { sdkVersion: '0.6.104', registeredProviders: ['codex', 'copilot'].filter(id => (v.providers as unknown[]).includes(id)),
    machineProviderCount: v.machineProviders.length, isolatedProviderRegistered: v.machineProviders.includes('sf-native-probe-isolated'),
    enrolledMachineCount: v.machines.length, accessProvider: access.selectedProvider === 'connect' ? 'connect' : access.selectedProvider === 'direct' ? 'direct' : 'other',
    hasConfiguredOrigin: typeof access.configuredOrigin === 'string', availableAccessProviderCount: Array.isArray(access.availableProviders) ? access.availableProviders.length : 0,
    liveNativeLifecycle: false, verifiedProfileIds: [], initialCredentialDenyAvailable: false,
    inheritedGitStatus: ['logged in', 'not logged in', 'disabled', 'overridden'].includes(String(forwarding.builtInGitStatus)) ? forwarding.builtInGitStatus : 'unknown',
    inheritedVariableCount: Number.isSafeInteger(forwarding.configuredVariableCount) && Number(forwarding.configuredVariableCount) >= 0 ? forwarding.configuredVariableCount : null,
    bootstrapExecutorCalls: Number.isSafeInteger(bootstrap.executorCalls) && Number(bootstrap.executorCalls) >= 0 ? bootstrap.executorCalls : null,
    bootstrapExitCodes: Array.isArray(bootstrap.exitCodes) ? bootstrap.exitCodes.filter(code => Number.isInteger(code) && code >= 0 && code <= 255).slice(0, 32) : [] };
}

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { probeVsCode, type ProbeRuntime } from '../probes/vscode.ts';
import { windowsNativeRuntime } from '../probes/windows.ts';
export async function runVsCodeProbeCli(args: string[], makeNativeRuntime = windowsNativeRuntime) {
  const { values } = parseArgs({ args, options: {
    live: { type: 'boolean', default: false }, 'scratch-repo': { type: 'string' }, provider: { type: 'string', default: 'copilot' },
    endpoint: { type: 'string' }, 'output-dir': { type: 'string', default: 'logs/probes' }, 'windows-helper': { type: 'boolean', default: false }, 'windows-helper-root': { type: 'string' }, 'allow-native-ask-user': { type: 'boolean', default: false }, 'timeout-ms': { type: 'string' }, 'input-idempotency-key': { type: 'string' },
  } });
  if (!values['scratch-repo'] || !['copilot', 'codex'].includes(values.provider!)) throw new Error('Supply --scratch-repo and --provider copilot|codex');
  if ((values['windows-helper'] || values['windows-helper-root']) && !values.live) throw new Error('Native Windows helper requires explicit --live permission');
  const runtime: ProbeRuntime = values['windows-helper'] ? makeNativeRuntime(values['windows-helper-root']) : {};
  runtime.allowNativeAskUser = values['allow-native-ask-user'];
  if (values['timeout-ms']) {
    const timeout = Number(values['timeout-ms']);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) throw new Error('timeout-ms must be between 1000 and 60000');
    runtime.timeoutMs = timeout;
  }
  if (values['input-idempotency-key']) runtime.inputIdempotencyKey = values['input-idempotency-key'];
  const report = await probeVsCode({ ...(values.live ? { mode: 'live' as const, allowLive: true as const } : { mode: 'fixture' as const, allowLive: false }),
    scratchRepo: values['scratch-repo'], outputDir: values['output-dir']!, provider: values.provider as 'copilot' | 'codex',
    ...(values.endpoint ? { endpoint: values.endpoint } : {}) }, runtime);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runVsCodeProbeCli(process.argv.slice(2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

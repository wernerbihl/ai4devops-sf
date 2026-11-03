import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { probeBb } from '../probes/bb.ts';
export async function runBbProbeCli(args: string[]) {
  const { values } = parseArgs({ args, options: { live: { type: 'boolean', default: false }, 'scratch-repo': { type: 'string' }, 'output-dir': { type: 'string', default: 'logs/probes/bb' }, endpoint: { type: 'string' } } });
  if (!values['scratch-repo']) throw new Error('Supply --scratch-repo');
  return probeBb({ ...(values.live ? { mode: 'live' as const, allowLive: true as const } : { mode: 'fixture' as const, allowLive: false }), scratchRepo: values['scratch-repo'], outputDir: values['output-dir']!, provider: 'codex', ...(values.endpoint ? { endpoint: values.endpoint } : {}) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runBbProbeCli(process.argv.slice(2)); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { dirname, join } from 'node:path';
/** Invoke npm's JavaScript entry directly: Windows .cmd files are not executables for execFile. */
export function runNpm(args:string[],options:ExecFileSyncOptionsWithStringEncoding):string {
 const cli=process.env.npm_execpath??join(dirname(process.execPath),process.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'../lib/node_modules/npm/bin/npm-cli.js');
 return execFileSync(process.execPath,[cli,...args],options);
}

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProcessDocker, PosixInstallationSecrets } from '../kestra/deployment.ts';
import { startRuntime } from './runtime.ts';
/** Private installation service entry. Public CLI remains setup/next/uninstall. */
export async function main(args=process.argv.slice(2)) {
  if(args.length!==2||!args[0]||!args[1])throw new Error('Private service requires installation ID and absolute installation directory');
  const runtime=await startRuntime({id:args[0],root:resolve(args[1]),docker:new ProcessDocker(process.env.SF_DOCKER_EXECUTABLE??'docker'),secrets:new PosixInstallationSecrets()});
  const stop=()=>{void runtime.stop().then(()=>{process.exitCode=0})};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return runtime;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().catch(()=>{process.stderr.write('Factory service startup failed; inspect protected installation configuration and owned runtime resources.\n');process.exitCode=1});

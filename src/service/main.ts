import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProcessDocker, PosixInstallationSecrets, WindowsInstallationSecrets } from '../kestra/deployment.ts';
import { readPrivateFileAsync } from './config.ts';
import { startRuntime } from './runtime.ts';
/** Private installation service entry. Public CLI remains setup/next/uninstall. */
export async function main(args=process.argv.slice(2)) {
  if((args.length!==2 && !(process.platform==='win32'&&args.length===3))||!args[0]||!args[1])throw new Error('Private service requires installation ID and absolute installation directory');
  let executable=process.env.SF_DOCKER_EXECUTABLE??'docker';
  if(args[2]){const startup=JSON.parse((await readPrivateFileAsync(join(resolve(args[1]),'startup.json'))).toString());if(!isAbsolute(args[2])||startup.installationId!==args[0]||startup.dockerExecutable!==args[2])throw new Error('Protected Docker executable mismatch');executable=args[2]}
  const runtime=await startRuntime({id:args[0],root:resolve(args[1]),docker:new ProcessDocker(executable),secrets:process.platform==='win32'?new WindowsInstallationSecrets():new PosixInstallationSecrets()});
  const stop=()=>{void runtime.stop().then(()=>{process.exitCode=0})};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return runtime;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().catch(()=>{process.stderr.write('Factory service startup failed; inspect protected installation configuration and owned runtime resources.\n');process.exitCode=1});

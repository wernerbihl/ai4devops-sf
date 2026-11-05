export const PUBLIC_COMMANDS = ['setup', 'next', 'uninstall'] as const;
export type PublicCommand = typeof PUBLIC_COMMANDS[number];
export interface ParsedCommand { command: PublicCommand | undefined; help: boolean }

export function parseCommand(argv: string[]): ParsedCommand {
  let command: PublicCommand | undefined;
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      if (help) throw new Error('Help flag may only appear once');
      help = true;
    } else if (!command && (PUBLIC_COMMANDS as readonly string[]).includes(arg)) {
      command = arg as PublicCommand;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!command && !help) throw new Error('Choose setup, next, or uninstall');
  return { command, help };
}

export interface CliIo { out(text:string):void;err(text:string):void;ask(prompt:string):Promise<string> }
export async function runCli(argv:string[],io:CliIo,deps:{locate?:typeof import('../install/locator.ts').locateInstallation;uninstall?:typeof import('../install/uninstall.ts').uninstallInstallation}={}):Promise<number> {
  let parsed:ParsedCommand;
  try{parsed=parseCommand(argv)}catch(error){io.err((error instanceof Error?error.message:'Invalid command')+'\n');return 2}
  if(parsed.help){io.out('Usage: ai4devops-sf <setup|next|uninstall> [--help]\n');return 0}
  try {
    if(parsed.command==='setup'){const {runSetup}=await import('./setup.ts');return await runSetup(io)}
    const locate=deps.locate??(await import('../install/locator.ts')).locateInstallation;const installation=await locate();
    if(!installation){io.err('No installation found. Run ai4devops-sf setup.\n');return 1}
    if(parsed.command==='next'){
      const {nextInstallation}=await import('./installed-next.ts');const result=await nextInstallation(installation);
      if(result.state==='pending'){io.err(`Dispatch ${result.key} remains pending; run next again to check the same request.\n`);return 1}
      io.out(JSON.stringify(result.body)+'\n');return 0;
    }
    const uninstall=deps.uninstall??(await import('../install/uninstall.ts')).uninstallInstallation;const report=await uninstall(installation);
    if(report.removed.length)io.out(`Removed owned resources:\n${report.removed.join('\n')}\n`);
    if(report.blocked.length){io.err(`Cleanup remains blocked or retained:\n${report.blocked.map(item=>item.kind+': '+item.identity).join('\n')}\n`);return 1}
    io.out('Uninstall complete.\n');return 0;
  } catch(error){io.err((error instanceof Error?error.message:'Factory command failed')+'\n');return 1}
}

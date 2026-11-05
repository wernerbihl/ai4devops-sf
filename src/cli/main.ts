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

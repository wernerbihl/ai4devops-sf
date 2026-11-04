import { devNull } from 'node:os';
import { runProcess } from '../github/gh.ts';

export interface LocalGitRequest {
  cwd: string;
  args: readonly string[];
  hooksDirectory: string;
  gitDirectory?: string;
  workTree?: string;
  allowedExitCodes?: readonly number[];
}
export interface LocalGitResult { stdout: string; code: number }
export type LocalGit = (request: LocalGitRequest) => Promise<LocalGitResult>;
export interface LocalGitOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Trusted diagnostics: no credentials, child output or inherited environment. */
  onInvocation?(invocation: { args: readonly string[]; options: { shell: false } }): void;
}

/** Local operations only. Authenticated network Git belongs exclusively to C6's GitAuthPort. */
export function createLocalGit(options: LocalGitOptions = {}): LocalGit {
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw new TypeError('Bounded local Git limits required');
  return async request => {
    const env: Record<string, string> = {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    };
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'])
      if (process.env[key]) env[key] = process.env[key]!;
    const args = [
      '-c', `core.hooksPath=${request.hooksDirectory}`,
      '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'protocol.allow=never',
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', `core.attributesFile=${devNull}`, '-c', 'submodule.recurse=false',
      ...(request.gitDirectory ? [`--git-dir=${request.gitDirectory}`] : []),
      ...(request.workTree ? [`--work-tree=${request.workTree}`] : []),
      ...request.args,
    ];
    options.onInvocation?.({ args, options: { shell: false } });
    try {
      const result = await runProcess({ command: 'git', args, cwd: request.cwd, env, timeoutMs, maxBytes });
      if (!(request.allowedExitCodes ?? [0]).includes(result.code)) throw new Error();
      return { code: result.code, stdout: result.stdout };
    } catch {
      // Git's messages can contain remote URLs and arbitrary repository-controlled strings.
      throw new Error('Managed local Git failed or exceeded its I/O limit; retain the workspace and inspect trusted state');
    }
  };
}

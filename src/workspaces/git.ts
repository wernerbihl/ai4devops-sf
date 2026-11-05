import { devNull } from 'node:os';
import { GitWriterFailure, ProcessFailure, runProcess } from '../github/gh.ts';
import type { ProcessPort } from '../github/gh.ts';

export interface LocalGitRequest {
  cwd: string;
  args: readonly string[];
  hooksDirectory: string;
  gitDirectory?: string;
  workTree?: string;
  allowedExitCodes?: readonly number[];
}
export interface LocalGitResult { stdout: string; code: number }
/** Return only after normal managed-command completion; throw GitWriterFailure with truthful
 * stopped/unknown evidence. Generic injected errors are treated as unknown by the manager. */
export type LocalGit = (request: LocalGitRequest) => Promise<LocalGitResult>;
export interface LocalGitOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Trusted process-boundary injection; returned results must establish normal foreground completion. */
  process?: ProcessPort;
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
      '-c', 'maintenance.auto=false', '-c', 'maintenance.autoDetach=false',
      '-c', 'gc.auto=0', '-c', 'gc.autoDetach=false', '-c', 'fetch.writeCommitGraph=false',
      ...(request.gitDirectory ? [`--git-dir=${request.gitDirectory}`] : []),
      ...(request.workTree ? [`--work-tree=${request.workTree}`] : []),
      ...request.args,
    ];
    options.onInvocation?.({ args, options: { shell: false } });
    try {
      const result = await (options.process ?? runProcess)({ command: 'git', args, cwd: request.cwd, env, timeoutMs, maxBytes });
      if (!(request.allowedExitCodes ?? [0]).includes(result.code))
        throw new GitWriterFailure('stopped', 'Managed local Git exited unsuccessfully; retain the workspace and inspect trusted state');
      return { code: result.code, stdout: result.stdout };
    } catch (error) {
      // Git's messages can contain remote URLs and arbitrary repository-controlled strings.
      const completion = error instanceof GitWriterFailure ? error.writerCompletion
        : error instanceof ProcessFailure ? error.completion : 'unknown';
      throw new GitWriterFailure(completion, 'Managed local Git failed or exceeded its I/O limit; retain the workspace and inspect trusted writer state');
    }
  };
}

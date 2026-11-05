import { GitHubFailure, safeFailure } from './gh.ts';
import type { GhDependencies } from './gh.ts';
/** Deliberately excludes shell snippets and helpers capable of starting interactive OAuth flows. */
const supported = new Set(['cache', 'store', 'osxkeychain', 'libsecret', 'manager', 'manager-core']);
export function createCredentialHelper(deps: GhDependencies) {
  return {
    async token(signal?: AbortSignal): Promise<string | undefined> {
      const run = async (args: string[], input?: string) => {
        try {
          return await deps.process({
            command: 'git',
            args,
            env: deps.env,
            timeoutMs: deps.timeoutMs,
            maxBytes: deps.maxBytes,
            ...(input === undefined ? {} : { input }),
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          throw safeFailure(error);
        }
      };
      const configuration = await run([
        'config',
        '--null',
        '--get-urlmatch',
        'credential.helper',
        'https://github.com',
      ]);
      if (configuration.missing || (configuration.code === 1 && !configuration.stdout)) return undefined;
      if (configuration.code !== 0)
        throw new GitHubFailure(
          'unavailable',
          'Cannot inspect HTTPS credential helpers; configure gh auth login',
        );
      const helpers = configuration.stdout.split('\0').filter(Boolean);
      if (!helpers.length) return undefined;
      for (const helper of helpers) {
        if (!supported.has(helper))
          throw new GitHubFailure(
            'unavailable',
            'Configured HTTPS credential helper is unsupported; use gh auth login or a supported noninteractive helper',
          );
        const result = await run([`credential-${helper}`, 'get'], 'protocol=https\nhost=github.com\n\n');
        if (result.code !== 0 || result.missing)
          throw new GitHubFailure(
            'unavailable',
            'HTTPS credential helper failed; repair it or use gh auth login',
          );
        const entries: Record<string, string> = {};
        for (const line of result.stdout.split('\n')) {
          if (!line) continue;
          const equal = line.indexOf('=');
          if (equal < 1 || entries[line.slice(0, equal)] !== undefined)
            throw new GitHubFailure('unavailable', 'HTTPS credential helper returned invalid credentials');
          entries[line.slice(0, equal)] = line.slice(equal + 1);
        }
        if (
          (entries.protocol && entries.protocol !== 'https') ||
          (entries.host && entries.host !== 'github.com') ||
          entries.url ||
          entries.quit === 'true' ||
          entries.quit === '1'
        )
          throw new GitHubFailure(
            'unavailable',
            'HTTPS credential helper requires attention; use credentials for github.com',
          );
        const token = entries.password;
        if (token) {
          if (/\s/.test(token) || token.length > 4096)
            throw new GitHubFailure('unavailable', 'HTTPS credential helper returned invalid credentials');
          return token;
        }
      }
      return undefined;
    },
  };
}

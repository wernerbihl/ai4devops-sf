import { createWindowsCredentialStore } from './windows-store.ts';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AuthState, DeviceFlow } from '../contracts/domain.ts';
import type { ApiError } from '../contracts/domain.ts';
import type { ApiFailureStatus } from '../service/api.ts';
import { validateContract } from '../contracts/schemas.ts';
import { GitHubFailure } from './gh.ts';
export interface SelectedIdentity {
  accountId: string;
  login: string;
}
export interface AppCredential {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  refreshPending?: boolean;
}
export interface PrivateFlow {
  public: DeviceFlow;
  deviceCode: string;
  nextPollAt: number;
  exchangePending?: boolean;
}
export type AuthOutcome =
  | { kind: 'pending'; operation: string }
  | { kind: 'complete'; operation: string; body: AuthState | DeviceFlow }
  | { kind: 'failed'; operation: string; status: ApiFailureStatus; error: ApiError };
export interface AuthRecord {
  version: 1;
  selected?: SelectedIdentity;
  state: AuthState;
  app?: AppCredential;
  flows: Record<string, PrivateFlow>;
  outcomes: Record<string, AuthOutcome>;
}
/** This entire store is private. Never place it in snapshots, recipe state, or worker capabilities. */
export interface CredentialStore {
  readonly protectsSecrets: boolean;
  read(): Promise<AuthRecord>;
  run<T>(action: (record: AuthRecord, save: () => Promise<void>) => Promise<T>): Promise<T>;
}
const queues = new Map<string, Promise<unknown>>();
export function createFileCredentialStore(directory: string): CredentialStore {
  if(process.platform==='win32')return createWindowsCredentialStore(directory);
  if (!isAbsolute(directory)) throw new TypeError('Absolute protected authentication directory required');
  const protectsSecrets = true;
  directory = resolve(directory);
  const file = join(directory, 'auth.json');
  const assertOwned = (path: string, mode: number, directoryExpected: boolean) => {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      stat.isDirectory() !== directoryExpected ||
      (!directoryExpected && !stat.isFile()) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (protectsSecrets && (stat.mode & 0o777) !== mode)
    )
      throw new GitHubFailure(
        'unavailable',
        'Authentication storage is not private; repair its ownership and permissions',
      );
  };
  function prepare() {
    // Windows fallback stores safe metadata only. App secrets require an injected OS-protected store.
    const root = parse(directory).root;
    let current = root;
    for (const component of directory.slice(root.length).split(sep)) {
      current = join(current, component);
      if (existsSync(current)) {
        if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory())
          throw new GitHubFailure('unavailable', 'Authentication storage must not traverse symbolic links');
      } else mkdirSync(current, { mode: 0o700 });
    }
    assertOwned(directory, 0o700, true);
  }
  function load(): AuthRecord {
    if (!existsSync(file))
      return {
        version: 1,
        state: {
          status: 'unavailable',
          reasons: ['Probe GitHub authentication to verify the selected account'],
        },
        flows: {},
        outcomes: {},
      };
    assertOwned(file, 0o600, false);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (stat.size > 4 * 1024 * 1024) throw new Error();
      const value = JSON.parse(readFileSync(fd, 'utf8')) as AuthRecord;
      if (value.version !== 1 || !value.state || !value.flows || !value.outcomes) throw new Error();
      validateContract('AuthState', value.state);
      if (
        value.selected &&
        (!/^\d+$/.test(value.selected.accountId) || !/^[a-z\d][a-z\d-]{0,38}$/i.test(value.selected.login))
      )
        throw new Error();
      if (!protectsSecrets && (value.app || Object.values(value.flows).some((flow) => flow.deviceCode)))
        throw new Error();
      return value;
    } catch {
      throw new GitHubFailure(
        'unavailable',
        'Authentication storage is invalid; restore the protected authentication record',
      );
    } finally {
      closeSync(fd);
    }
  }
  function save(record: AuthRecord) {
    if (!protectsSecrets && (record.app || Object.values(record.flows).some((flow) => flow.deviceCode)))
      throw new GitHubFailure(
        'unavailable',
        'An OS-protected credential store is required for GitHub App secrets',
      );
    const temp = join(directory, `.auth-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      assertOwned(temp, 0o600, false);
      const content = JSON.stringify(record);
      if (Buffer.byteLength(content) > 4 * 1024 * 1024)
        throw new GitHubFailure(
          'unavailable',
          'Authentication journal capacity reached; archive completed API outcomes through trusted maintenance',
        );
      writeFileSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (existsSync(file)) assertOwned(file, 0o600, false);
      renameSync(temp, file);
      if (protectsSecrets) {
        const dir = openSync(directory, constants.O_RDONLY);
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
  return {
    protectsSecrets,
    async read() {
      prepare();
      return load();
    },
    async run<T>(action: (record: AuthRecord, save: () => Promise<void>) => Promise<T>): Promise<T> {
      const previous = queues.get(directory) ?? Promise.resolve();
      const result = previous
        .catch(() => {})
        .then(async () => {
          prepare();
          const lock = join(directory, '.lock.sqlite');
          const lockFd = openSync(lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
          closeSync(lockFd);
          assertOwned(lock, 0o600, false);
          const mutex = new DatabaseSync(lock);
          mutex.exec('PRAGMA busy_timeout=0');
          let acquired = false;
          try {
            mutex.exec('BEGIN IMMEDIATE');
            acquired = true;
            const record = load();
            return await action(record, async () => save(record));
          } catch (error) {
            if (!acquired)
              throw new GitHubFailure(
                'unavailable',
                'Authentication storage is busy; stop duplicate factory runners before retrying',
              );
            throw error;
          } finally {
            try {
              if (acquired) mutex.exec('ROLLBACK');
            } finally {
              mutex.close();
            }
          }
        });
      queues.set(directory, result);
      try {
        return await result;
      } finally {
        if (queues.get(directory) === result) queues.delete(directory);
      }
    },
  };
}

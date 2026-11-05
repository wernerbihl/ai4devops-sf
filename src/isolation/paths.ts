import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ensure, StoreError } from '../storage/database.ts';

/** Resolve existing aliases; for an absent leaf retain its suffix under the real existing ancestor.
 * A dangling symlink, non-directory parent, permission failure or unresolved root is not protection. */
async function resolveProtectedPath(path: string): Promise<string> {
  ensure(isAbsolute(path) && resolve(path) === path, 'profile_protection', 'Protected paths must be normalized absolute paths');
  let ancestor = path; const absent: string[] = [];
  for (;;) {
    let exists = true;
    try { await lstat(ancestor); }
    catch (error) {
      ensure((error as NodeJS.ErrnoException).code === 'ENOENT', 'profile_protection', 'Protected path cannot be inspected');
      exists = false;
    }
    if (exists) {
      let effective: string;
      try { effective = await realpath(ancestor); }
      catch { throw new StoreError('profile_protection', 'Protected path alias cannot be resolved'); }
      if (absent.length) ensure((await stat(effective)).isDirectory(), 'profile_protection', 'Protected path ancestor is not a directory');
      return join(effective, ...absent);
    }
    const parent = dirname(ancestor);
    ensure(parent !== ancestor, 'profile_protection', 'Protected path has no resolvable ancestor');
    absent.unshift(basename(ancestor)); ancestor = parent;
  }
}
/** Same union is used for mount containment, OS canaries and actual native/client-tool canaries. */
export async function resolveProtectedPaths(paths: readonly string[]): Promise<string[]> {
  const targets = new Set<string>();
  for (const path of paths) { targets.add(path); targets.add(await resolveProtectedPath(path)); }
  return [...targets].sort();
}

import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { writeWindowsPrivateFile } from '../platform/windows-private.ts';
import { dirname } from 'node:path';
import { canonical, ensure } from '../storage/database.ts';
import { readPrivateFile } from './config.ts';

export function createProxyPlaceholder(path: string): { dev: number; ino: number } {
  if(process.platform==='win32'){writeWindowsPrivateFile(path,Buffer.from('{}'));const stat=statSync(path);return {dev:stat.dev,ino:stat.ino}}
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, '{}'); fsyncSync(fd); const stat = fstatSync(fd); const dir = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); } return {dev:stat.dev, ino:stat.ino}; }
  finally { closeSync(fd); }
}
/** Keep the same bind-mounted inode. A torn or foreign file is retained for attention. */
export function finalizeProxyPolicy(path: string, policy: object): void {
  const previous = JSON.parse(readPrivateFile(path).toString()) as unknown;
  if (canonical(previous) === canonical(policy)) return;
  ensure(canonical(previous) === '{}', 'native_proxy', 'Unknown proxy policy; do not overwrite');
  const before = statSync(path);
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    ensure(opened.dev === before.dev && opened.ino === before.ino && readFileSync(fd, 'utf8') === '{}', 'native_proxy', 'Proxy placeholder identity changed');
    const bytes = Buffer.from(JSON.stringify(policy));
    let offset = 0;
    while (offset < bytes.length) { const count = writeSync(fd,bytes,offset,bytes.length-offset,offset); ensure(count > 0, 'native_proxy', 'Proxy policy write failed'); offset += count; }
    ftruncateSync(fd,bytes.length); fsyncSync(fd);
  } finally { closeSync(fd); }
}

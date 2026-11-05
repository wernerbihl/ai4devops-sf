import { isAbsolute } from 'node:path';

export interface LinuxServiceSpec { node: string; entry: string; id: string; root: string }

/** Systemd performs its own specifier and environment expansion even without a shell. */
function unitArgument(value: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid service argument');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}

export function linuxUnit(spec: LinuxServiceSpec): string {
  if (![spec.node, spec.entry, spec.root].every(isAbsolute) || !/^[A-Za-z0-9_-]{1,100}$/.test(spec.id)) throw new Error('Absolute service paths and an installation ID are required');
  const command = [spec.node, spec.entry, spec.id, spec.root].map(unitArgument).join(' ');
  return `[Unit]\nDescription=AI4DevOps Software Factory\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

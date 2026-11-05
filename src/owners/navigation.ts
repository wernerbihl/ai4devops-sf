import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NativeIdentity } from '../contracts/domain.ts';
import { ensure } from '../storage/database.ts';
const exec = promisify(execFile);
// Source-verified openSessionLink.ts; this is not a claim of live selected-session observation.
export const navigationCommits = ['3c0ec3a089398503a462029e7cc2a5749df5169a', 'e576c7bbeb39772a1d1ebe472545def0d93e6d8b'] as const;
export function nativeOpenUri(identity: NativeIdentity, commit: string, connectionAuthority?: string): string {
    ensure(navigationCommits.some(c => c === commit), 'owner_version', 'Native navigation host commit is unsupported');
    const session = new URL(identity.sessionId);
    ensure(session.protocol === 'ahp-session:' && !session.host && !session.search && !session.hash && /^\/[\w-]+$/.test(session.pathname), 'owner_navigation', 'Unsupported native session URI');
    const chat = identity.chatId && identity.chatId !== 'default' ? `/chat/${encodeURIComponent(encodeURIComponent(identity.chatId))}` : '';
    return `vscode-insiders://agents/agent-host-session/ahp-session${session.pathname}${chat}${connectionAuthority ? `?connectionAuthority=${encodeURIComponent(connectionAuthority)}` : ''}`;
}
export interface NativeNavigation {
    launch(uri: string): Promise<void>;
    connectionAuthority?: string;
}
/** Explicit CLI path supports remote/Windows ownership without shell interpolation. */
export function createNativeNavigation(cliPath?: string): NativeNavigation {
    return { async launch(uri) {
            if (cliPath) {
                await exec(cliPath, ['--open-url', uri]);
                return;
            }
            if (process.platform === 'darwin') {
                await exec('open', [uri]);
                return;
            }
            if (process.platform === 'win32') {
                await exec('rundll32.exe', ['url.dll,FileProtocolHandler', uri]);
                return;
            }
            await exec('xdg-open', [uri]);
        } };
}

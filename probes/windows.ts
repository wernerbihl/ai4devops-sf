import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AhpTransport, JsonRpcMessage } from '@microsoft/agent-host-protocol/client';
import type { ProbeRuntime } from './vscode.ts';
import { ProbeBlocked } from './common.ts';
const exec = promisify(execFile);
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const code = String.raw`C:\Users\wbihl\AppData\Local\Programs\Microsoft VS Code Insiders\Code - Insiders.exe`;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function windowsFileUri(path: string): string {
  return new URL(`file:${path.replaceAll('\\', '/')}`).href;
}

/** Environment-specific, approved diagnostic helper; not a production Windows launcher. */
export function windowsNativeRuntime(stagingRoot?: string): ProbeRuntime {
  return {
    requiresLivePermission: true,
    async workspaceUri(path) {
      if (stagingRoot) return windowsFileUri(`${stagingRoot}\\scratch`);
      const { stdout } = await exec('wslpath', ['-w', path]);
      return windowsFileUri(stdout.trim());
    },
    async connect(): Promise<AhpTransport> {
      const script = fileURLToPath(new URL('../scripts/vscode-native-pipe-helper.mjs', import.meta.url));
      const windowsScript = stagingRoot ? `${stagingRoot}\\scripts\\vscode-native-pipe-helper.mjs` : (await exec('wslpath', ['-w', script])).stdout.trim();
      const interopEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        WSLENV: [...(process.env.WSLENV ?? '').split(':').filter(Boolean), 'ELECTRON_RUN_AS_NODE'].join(':') };
      const child = spawn('/mnt/c/Users/wbihl/AppData/Local/Programs/Microsoft VS Code Insiders/Code - Insiders.exe', [windowsScript],
        { stdio: ['pipe', 'pipe', 'pipe'], env: interopEnv });
      // Never forward helper stderr, which may contain raw endpoint or library diagnostics.
      let helperError = '';
      child.stderr.on('data', chunk => {
        const match = chunk.toString().match(/SF_NATIVE_HELPER_ERROR ([A-Z_0-9]+)|\b(ERR_[A-Z_0-9]+)\b/);
        if (match) helperError = match[1] ?? match[2];
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
      return {
        send(message: JsonRpcMessage | string) {
          if (!child.stdin.writable) throw new ProbeBlocked('Windows native IPC helper unavailable');
          child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
        },
        async recv() {
          const next = await lines.next();
          if (next.done) throw new ProbeBlocked(`Windows native IPC helper exited${helperError ? ` (${helperError})` : ''}`);
          return { kind: 'text', text: next.value };
        },
        close() { child.stdin.end(); child.kill(); },
      };
    },
    navigation: {
      hostCommit: '3c0ec3a089398503a462029e7cc2a5749df5169a',
      async open(uri) {
        await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command',
          `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process -FilePath ${quote(code)} -ArgumentList @('--open-url',${quote(uri)})`], { timeout: 10_000 });
        // A URL launch has no native selected-chat observation. Keep native-open BLOCKED.
        return undefined;
      },
    },
  };
}

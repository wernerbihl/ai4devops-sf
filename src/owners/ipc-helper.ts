// Private packaged worker entry; not a public CLI command. Never emits endpoint/provider credentials.
import { createInterface } from 'node:readline';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connectAhp, type AhpEndpoint } from './ahp.ts';
try {
    const config = JSON.parse(process.argv[2] ?? '{}') as AhpEndpoint | {
        registryDirectory: string;
    };
    let endpoint: AhpEndpoint;
    if ('registryDirectory' in config) {
        const matches: string[] = [];
        for (const file of await readdir(config.registryDirectory)) {
            if (!file.endsWith('.json'))
                continue;
            const path = join(config.registryDirectory, file);
            try {
                const e = JSON.parse(await readFile(path, 'utf8'));
                if (e.schemaVersion !== 2 || e.type !== 'editor' || !Number.isInteger(e.pid))
                    continue;
                process.kill(e.pid, 0);
                matches.push(path);
            }
            catch { /* Ignore stale registry entries only. */ }
        }
        if (matches.length !== 1)
            throw Error('Select exact native endpoint');
        endpoint = { registryPath: matches[0]! };
    }
    else
        endpoint = config;
    const transport = await connectAhp(endpoint);
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', line => {
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
            void transport.close();
            return;
        }
        try {
            void transport.send(line);
        }
        catch {
            void transport.close();
        }
    });
    lines.on('close', () => { void transport.close(); });
    for (;;) {
        const frame = await transport.recv();
        if (!frame)
            break;
        if (frame.kind !== 'text')
            throw Error('Unsupported native frame');
        process.stdout.write(frame.text + '\n');
    }
    lines.close();
}
catch {
    process.stderr.write('Native IPC helper unavailable or authentication rejected\n');
    process.exitCode = 2;
}

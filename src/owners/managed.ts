import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client';
import { verifyNativeStateMount, type NativeStateMount, type NativeStateOwnership } from '../isolation/native-state.ts';
import type { DockerPort } from '../kestra/deployment.ts';
import { ProcessDocker } from '../kestra/deployment.ts';
import { ensure, fingerprint } from '../storage/database.ts';
import type { ManagedOwnerLauncher } from './vscode.ts';
import type { NativeStart } from '../contracts/domain.ts';
import type { FactoryToolGate } from './tools.ts';
export interface ManagedVsCodeOptions {
    containerId: string;
    runtimeOwnerId: string;
    image: string;
    entrypoint: string;
    entrypointSha256: string;
    nativeState: NativeStateMount;
    nativeStateOwnership: NativeStateOwnership;
    userDataDir: string;
    tokenFile: string;
    port: number;
    docker?: DockerPort;
    dockerExecutable?: string;
}
export interface NativeProcess {
    pid: number;
    startTime: string;
    netNamespace: string;
    mountNamespace: string;
    pidNamespace: string;
    bootId: string;
    entrypoint: string;
}
export const nativeProcessIdentity = (process: NativeProcess) => fingerprint(process);
// The inspector runs as the container's configured unprivileged user. No provider files are opened.
const inspectProgram = String.raw `const fs=require('node:fs'),crypto=require('node:crypto');const p=JSON.parse(process.argv[1]);const processes=[];for(const d of fs.readdirSync('/proc')){if(!/^\d+$/.test(d))continue;try{const args=fs.readFileSync('/proc/'+d+'/cmdline','utf8').split('\0');if(!args.includes(p.entrypoint))continue;for(const [flag,value]of [['--connection-token-file',p.tokenFile],['--user-data-dir',p.userDataDir],['--host','127.0.0.1'],['--port',String(p.port)]])if(args[args.indexOf(flag)+1]!==value)throw Error('unmanaged');const stat=fs.readFileSync('/proc/'+d+'/stat','utf8').split(') ')[1].split(' ');processes.push({pid:Number(d),startTime:stat[19],netNamespace:fs.readlinkSync('/proc/'+d+'/ns/net'),mountNamespace:fs.readlinkSync('/proc/'+d+'/ns/mnt'),pidNamespace:fs.readlinkSync('/proc/'+d+'/ns/pid'),bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),entrypoint:p.entrypoint});}catch(e){if(e.message==='unmanaged')process.exit(2);}}const token=fs.statSync(p.tokenFile);if(!token.isFile()||(token.mode&63)!==0||token.uid!==process.getuid())process.exit(3);process.stdout.write(JSON.stringify({entrypointHash:crypto.createHash('sha256').update(fs.readFileSync(p.entrypoint)).digest('hex'),processes}));`;
// Official AHP JSON frames over authenticated loopback WebSocket, transported via owned Docker exec stdio.
const relayProgram = String.raw `const fs=require('node:fs'),readline=require('node:readline');const p=JSON.parse(process.argv[1]);const token=fs.readFileSync(p.tokenFile,'utf8').trim();if(!/^[\w-]{32,}$/.test(token))process.exit(2);const ws=new WebSocket('ws://127.0.0.1:'+p.port+'/?tkn='+encodeURIComponent(token));const pending=[];let ready=false;ws.addEventListener('open',()=>{ready=true;for(const v of pending)ws.send(v);pending.length=0;});ws.addEventListener('message',e=>{const s=String(e.data);if(s.length>8388608)process.exit(3);process.stdout.write(s+'\n');});ws.addEventListener('error',()=>process.exit(4));ws.addEventListener('close',()=>process.exit(0));const input=readline.createInterface({input:process.stdin});input.on('line',s=>{if(s.length>8388608)process.exit(3);if(ready)ws.send(s);else if(pending.length<64)pending.push(s);else process.exit(3);});input.on('close',()=>{ws.close();setTimeout(()=>process.exit(0),100).unref();});`;
export function createManagedVsCodeLauncher(options: ManagedVsCodeOptions): ManagedOwnerLauncher & {
    inspect(): Promise<{
        runtimeId: string;
        processIdentity: string;
        native: NativeProcess;
    }>;
    options: Readonly<ManagedVsCodeOptions>;
    resume(start: NativeStart, gate: Pick<FactoryToolGate, 'nativeIdentity'>): Promise<void>;
    resumeHuman(start: NativeStart, assertCurrent: () => void): Promise<void>;
    readonly controlIntentPath: string;
    readonly pauseReceiptPath: string;
} {
    ensure(/^[a-f0-9]{64}$/.test(options.containerId) && /^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(options.image) && /^[a-f0-9]{64}$/.test(options.entrypointSha256), 'owner_managed', 'Pinned managed container, image and entrypoint digest are required');
    ensure(options.entrypoint.startsWith('/') && options.entrypoint.endsWith('/out/vs/platform/agentHost/node/agentHostServerMain.js') && options.tokenFile.startsWith('/') && options.userDataDir.startsWith('/') && Number.isInteger(options.port) && options.port > 1024 && options.port < 65536, 'owner_managed', 'Unsupported native standalone launch configuration');
    ensure(options.nativeState.runtimeOwnerId === options.runtimeOwnerId && options.userDataDir === options.nativeState.target + '/user-data' && options.tokenFile === options.nativeState.target + '/connection-token', 'owner_managed', 'Native userdata/token must use the fixed persistent owned state mount');
    const docker = options.docker ?? new ProcessDocker(options.dockerExecutable);
    let starting: Promise<void> | undefined;
    const controlIntentPath = join(dirname(options.nativeState.markerPath), 'control-start.json');
    const pauseReceiptPath = join(dirname(options.nativeState.markerPath), 'control-pause.json');
    const syncControlDirectory = () => {
        const fd = openSync(dirname(controlIntentPath), 'r');
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    };
    const clearControlIntent = () => { unlinkSync(controlIntentPath); syncControlDirectory(); };
    const assertSettled = () => ensure(!existsSync(controlIntentPath), 'owner_control_unknown', 'Native control start is pending or outcome unknown; retain exclusion');
    async function processes() { const state = await verifyNativeStateMount(options.nativeState, options.nativeState.taskId, options.nativeStateOwnership); const c = JSON.parse(await docker.command(['container', 'inspect', options.containerId]))[0]; const image = JSON.parse(await docker.command(['image', 'inspect', options.image]))[0]; ensure(c?.Id === options.containerId && c.State?.Running && !c.State.Paused && c.Config?.Labels?.['sf.runtime-owner'] === options.runtimeOwnerId && c.Config.User && !/^(0|root)(:|$)/.test(c.Config.User) && image?.Id === c.Image && image.RepoDigests?.includes(options.image), 'owner_managed', 'Native runtime ownership/image changed'); ensure(c.Mounts?.some((m: any) => m.Type === 'bind' && m.Source === state.source && m.Destination === state.target && m.RW === true), 'owner_managed', 'Actual persistent native state mount is missing'); const value = JSON.parse(await docker.command(['exec', options.containerId, 'node', '-e', inspectProgram, JSON.stringify({ entrypoint: options.entrypoint, userDataDir: options.userDataDir, tokenFile: options.tokenFile, port: options.port })])); ensure(value.entrypointHash === options.entrypointSha256 && Array.isArray(value.processes) && value.processes.length <= 1, 'owner_managed', 'Native entrypoint digest or process identity mismatch'); return value.processes as NativeProcess[]; }
    async function start() {
        const before = await processes();
        if (before.length)
            return;
        await docker.command(['exec', '-d', options.containerId, 'node', options.entrypoint, '--host', '127.0.0.1', '--port', String(options.port), '--connection-token-file', options.tokenFile, '--user-data-dir', options.userDataDir, '--quiet']);
        const until = Date.now() + 15000;
        do {
            if ((await processes()).length === 1)
                return;
            await delay(50);
        } while (Date.now() < until);
        throw new Error('Managed native host did not start');
    }
    async function inspect() { assertSettled(); const p = await processes(); ensure(p.length === 1, 'owner_managed', 'Exactly one managed native process required'); const native = p[0]!; ensure(Number.isInteger(native.pid) && native.pid > 0 && native.startTime && native.netNamespace && native.mountNamespace && native.pidNamespace && native.bootId && native.entrypoint === options.entrypoint, 'owner_managed', 'Incomplete native process inspection'); return { runtimeId: options.containerId, processIdentity: nativeProcessIdentity(native), native }; }
    async function stoppedContainer() {
        await verifyNativeStateMount(options.nativeState, options.nativeState.taskId, options.nativeStateOwnership);
        const c = JSON.parse(await docker.command(['container', 'inspect', options.containerId]))[0];
        const image = JSON.parse(await docker.command(['image', 'inspect', options.image]))[0];
        ensure(c?.Id === options.containerId && c.Config?.Labels?.['sf.runtime-owner'] === options.runtimeOwnerId && image?.Id === c.Image && image.RepoDigests?.includes(options.image), 'owner_managed', 'Stopped runtime ownership/image changed');
        ensure(c.HostConfig?.RestartPolicy?.Name === 'no' && c.HostConfig.AutoRemove === false, 'owner_quiescence', 'Managed runtime must disable automatic restart and removal');
        return c;
    }
    const durableWrite = (path: string, value: unknown, exclusive = false) => { const fd = openSync(path, exclusive ? 'wx' : 'w', 0o600); try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    } syncControlDirectory(); };
    async function pausedProof() {
        assertSettled();
        if (!existsSync(pauseReceiptPath))
            return undefined;
        const c = await stoppedContainer();
        assertSettled();
        const proof = JSON.parse(readFileSync(pauseReceiptPath, 'utf8'));
        if (!c.State?.Paused)
            return undefined;
        ensure(c.State.Running === true && c.State.Pid > 0 && c.State.StartedAt && proof.schemaVersion === 1 && proof.runtimeId === options.containerId && proof.containerPid === c.State.Pid && proof.startedAt === c.State.StartedAt && proof.processIdentity === nativeProcessIdentity(proof.native), 'owner_quiescence', 'Frozen runtime/process identity changed');
        return proof;
    }
    async function paused() { if (existsSync(controlIntentPath))
        return false; return !!await pausedProof(); }
    async function pause() {
        if (await paused())
            return;
        const process = await inspect();
        const before = await stoppedContainer();
        ensure(before.State?.Running === true && before.State.Paused === false && before.State.Pid > 0 && before.State.StartedAt, 'owner_quiescence', 'Owned running container state required before freeze');
        durableWrite(controlIntentPath, { schemaVersion: 1, mode: 'pause', containerId: options.containerId }, true);
        await docker.command(['container', 'pause', options.containerId]);
        const after = await stoppedContainer();
        ensure(after.State?.Running === true && after.State.Paused === true && after.State.Pid === before.State.Pid && after.State.StartedAt === before.State.StartedAt, 'owner_quiescence', 'Kernel container pause was not proven');
        durableWrite(pauseReceiptPath, { schemaVersion: 1, ...process, containerPid: after.State.Pid, startedAt: after.State.StartedAt });
        clearControlIntent();
    }
    async function stopped() {
        if (existsSync(controlIntentPath))
            return false;
        const c = await stoppedContainer();
        return !existsSync(controlIntentPath) && c.State?.Running === false && c.State.Paused === false && c.State.Pid === 0 && c.State.Status === 'exited';
    }
    async function stop() {
        assertSettled();
        const before = await stoppedContainer();
        if (before.State?.Running)
            await docker.command(['container', 'stop', '--time', '10', options.containerId]);
        const after = await stoppedContainer();
        assertSettled();
        ensure(after.State?.Running === false && after.State.Paused === false && after.State.Pid === 0 && after.State.Status === 'exited', 'owner_quiescence', 'All native container processes are not proven stopped');
    }
    async function controlledResume(start: NativeStart, assertCurrent: () => void, mode: 'factory' | 'human') {
        ensure(start.task.id === options.nativeState.taskId, 'owner_binding', 'Restart must retain the provisioned task');
        assertCurrent();
        assertSettled();
        const frozen = await pausedProof();
        const c = await stoppedContainer();
        ensure(frozen || c.State?.Running === false && c.State.Paused === false && c.State.Pid === 0 && c.State.Status === 'exited', 'owner_quiescence', 'Resume requires a fully stopped or independently frozen native runtime');
        assertCurrent();
        const fd = openSync(controlIntentPath, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify({ schemaVersion: 1, mode, containerId: options.containerId, taskId: start.task.id, key: start.idempotencyKey }));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        syncControlDirectory();
        // Mutating Docker failures are unknown: never erase this durable exclusion merely because an inspect sees stopped.
        let settled = false;
        try {
            assertCurrent();
            await docker.command(['container', frozen ? 'unpause' : 'start', options.containerId]);
            if (frozen) {
                const processesNow = await processes();
                ensure(processesNow.length === 1 && nativeProcessIdentity(processesNow[0]!) === frozen.processIdentity, 'owner_quiescence', 'Resumed native process differs from the frozen question owner');
            }
            else
                await startNative();
            settled = true;
            assertCurrent();
            clearControlIntent();
            if (existsSync(pauseReceiptPath)) {
                unlinkSync(pauseReceiptPath);
                syncControlDirectory();
            }
        }
        catch (error) {
            if (settled) {
                clearControlIntent();
                await stop();
            }
            throw error;
        }
    }
    async function resume(start: NativeStart, gate: Pick<FactoryToolGate, 'nativeIdentity'>) { await controlledResume(start, () => { gate.nativeIdentity(start); }, 'factory'); }
    async function resumeHuman(start: NativeStart, assertCurrent: () => void) { await controlledResume(start, assertCurrent, 'human'); }
    const startNative = start;
    return { options: Object.freeze({ ...options }), inspect, stop, stopped, pause, paused, resume, resumeHuman, controlIntentPath, pauseReceiptPath, async ensureStarted() {
            assertSettled();
            if (!starting)
                starting = start().finally(() => { starting = undefined; });
            await starting;
            return { connect: async () => { await inspect(); return dockerAhpTransport(options); } };
        } };
}
function dockerAhpTransport(options: ManagedVsCodeOptions): AhpTransport {
    const child = spawn(options.dockerExecutable ?? 'docker', ['exec', '-i', options.containerId, 'node', '-e', relayProgram, JSON.stringify({ tokenFile: options.tokenFile, port: options.port })], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const queue: (TransportFrame | null)[] = [];
    let pending: ((value: TransportFrame | null) => void) | undefined;
    let closed = false;
    const deliver = (value: TransportFrame | null) => {
        if (pending) {
            const next = pending;
            pending = undefined;
            next(value);
        }
        else if (queue.length < 1024)
            queue.push(value);
        else {
            closed = true;
            child.kill();
        }
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', text => {
        if (Buffer.byteLength(text) > 8 * 1024 * 1024) {
            child.kill();
            return;
        }
        deliver({ kind: 'text', text });
    });
    child.stderr.resume();
    child.stdin.on('error', () => { });
    child.on('error', () => { closed = true; deliver(null); });
    child.on('close', () => { closed = true; deliver(null); });
    return { send(message) { ensure(!closed, 'owner_connection', 'Managed native transport closed'); child.stdin.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n'); }, async recv() {
            if (queue.length)
                return queue.shift()!;
            if (closed)
                return null;
            return new Promise(resolve => { pending = resolve; });
        }, close() { closed = true; child.stdin.end(); child.kill(); deliver(null); } };
}

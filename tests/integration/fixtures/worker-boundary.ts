import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FactoryStore } from '../../../src/storage/store.ts';
import type { FactoryToolGate } from '../../../src/owners/tools.ts';
import { IsolatedToolWorker } from '../../../src/owners/worker.ts';

export const physicallyStopped = (pid: number) => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('T') ?? false; }
  catch { return false; }
};

export async function processToolWorker(store: FactoryStore, gate: FactoryToolGate, workspace: string) {
  const child = fork(fileURLToPath(new URL('./worker-service.ts', import.meta.url)), [], {
    detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { PATH: process.env.PATH },
  });
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('message', (value: { pid: number }) => resolve(value.pid)); child.once('error', reject);
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
  child.on('message', (value: { id: number; code: number; output: string }) => {
    const call = pending.get(value.id); if (!call) return; pending.delete(value.id);
    if (value.code === 0) call.resolve(value.output); else call.reject(Error('Worker helper refused operation'));
  });
  const image = 'worker@sha256:' + 'a'.repeat(64);
  const config = { containerId: 'worker-process', nativeContainerId: 'native-process', runtimeOwnerId: 'fixture-worker', image, mountTargets: [{ source: workspace, target: '/workspaces/task' }] };
  // Docker layout facts are explicitly simulated. Process execution, helper validation,
  // actual worktree contents, durable authority and group freeze below are real.
  const inspect = () => ({
    Id: config.containerId, Image: 'worker-image',
    Config: { Image: image, Labels: { 'sf.runtime-owner': config.runtimeOwnerId }, User: '1000', WorkingDir: '/workspaces/task', Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'LANG=C.UTF-8'] },
    State: { Running: true, Paused: physicallyStopped(pid), Pid: pid, StartedAt: 'fixture-worker-epoch' },
    Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspaces/task', RW: true }],
    NetworkSettings: { Networks: { none: {} } },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], IpcMode: 'private', PidsLimit: 256, Memory: 2147483648, NanoCpus: 2e9, RestartPolicy: { Name: 'no' }, AutoRemove: false },
  });
  const mapPath = (path: string) => path === '/workspaces/task' || path.startsWith('/workspaces/task/') ? workspace + path.slice('/workspaces/task'.length) : path;
  const worker = new IsolatedToolWorker({ config, store, gate, docker: {
    async command(args, options) {
      if (args[0] === 'image') return JSON.stringify([{ Id: 'worker-image', RepoDigests: [image] }]);
      if (args[0] === 'container') {
        if (args[1] === 'pause') process.kill(-pid, 'SIGSTOP');
        else if (args[1] === 'unpause') process.kill(-pid, 'SIGCONT');
        // Give the kernel time to publish the process state; this is observed, not inferred.
        if (args[1] === 'pause') for (let i = 0; i < 100 && !physicallyStopped(pid); i++) await new Promise(resolve => setTimeout(resolve, 2));
        return JSON.stringify([inspect()]);
      }
      if (args[0] !== 'exec' || args[2] !== config.containerId) throw Error('Unexpected worker fixture command');
      const input = JSON.parse(options!.stdin!);
      input.cwd = mapPath(input.cwd); input.roots = input.roots.map((root: { target: string }) => ({ ...root, target: mapPath(root.target) }));
      if (input.operation.path) input.operation.path = mapPath(input.operation.path);
      return new Promise<string>((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, program: args.at(-1), input });
      });
    },
  } });
  return { worker, pid, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    process.kill(-pid, 'SIGCONT'); process.kill(-pid, 'SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  } };
}

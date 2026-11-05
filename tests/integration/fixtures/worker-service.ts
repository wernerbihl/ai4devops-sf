import { spawn } from 'node:child_process';

// Process substitute for a Docker worker cgroup. Helper executions and background shell
// children share this process group. This does not establish Docker mount/network isolation.
process.on('message', (message: { id: number; program: string; input: unknown }) => {
  const child = spawn(process.execPath, ['-e', message.program], {
    env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  child.stdin.end(JSON.stringify(message.input));
  child.on('close', code => { process.send?.({ id: message.id, code, output }); });
});
process.send?.({ pid: process.pid });

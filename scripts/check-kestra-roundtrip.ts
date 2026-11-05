import { boundRecipe, fixtureExecutionProfile } from '../tests/helpers/recipe-validation.ts';
/** Bounded integration check: real pinned engine + production client + explicit fixture broker.
 * Uses owned volumes because Windows Docker may not bind WSL files. This is NOT deployment-bind proof.
 * No native credentials/providers, no host mounts, no published ports, no user auth copying.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { ProcessDocker, createEngineTransport, kestraImagePins } from '../src/kestra/deployment.ts';
import { KestraClient } from '../src/kestra/client.ts';
import { encodeWorkerRequest, encodeWorkerResponse, decodeWorkerResponse } from '../src/contracts/worker-transport.ts';
import { openStore } from '../src/storage/store.ts';
import { RecipeRegistry } from '../src/recipes/registry.ts';
import { materializeTask } from '../src/recipes/materialize.ts';
import type { TaskResult, WorkerRequest } from '../src/contracts/domain.ts';

const docker = new ProcessDocker(process.env.SF_E2_DOCKER ?? 'docker');
const owner = 'sf-e2-' + randomUUID(); const root = mkdtempSync(join(tmpdir(), owner));
const resources: { kind: 'container' | 'volume' | 'network'; name: string }[] = [];
const label = ['--label', 'sf.e2.owner=' + owner];
const restrictions = ['--pull', 'never', '--platform', 'linux/amd64', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=1777'];
const store = openStore(':memory:'); let client: KestraClient | undefined;
const literal = '{% raw %}{{ inputs.secret }}{% endraw %} {{ 7*7 }} % "quotes"\n 日本語 🐈 \\u2028';
const secrets = { username: 'fixture@localhost.invalid', password: 'E2FixtureOnlyFixedCanaryPassword123', encryptionKey: Buffer.alloc(32, 7).toString('base64') };
const sleep = () => new Promise(resolve => setTimeout(resolve, 1000));
async function resource(kind: 'volume' | 'network', suffix: string): Promise<string> { const name = owner + '-' + suffix; resources.push({ kind, name }); await docker.command([kind, 'create', ...label, ...(kind === 'network' ? ['--internal'] : []), name]); return name; }
async function container(suffix: string, args: string[]): Promise<string> { const name = owner + '-' + suffix; resources.push({ kind: 'container', name }); await docker.command(['run', '--detach', '--name', name, ...label, ...args]); return name; }
const receipt: Record<string, unknown> = { owner, engine: kestraImagePins.kestra.image, worker: kestraImagePins.worker.image, platform: 'linux/amd64', productionClient: true, deployment: 'owned-volume fixture; product bind paths not exercised', native: 'fixture broker only', assertions: [] };
try {
  const source = parse(readFileSync(new URL('../recipes/starter/focused-feature.yaml', import.meta.url), 'utf8'));
  source.variables.sf.tagId = store.snapshot().tags[0]!.id; store.createRepository({ id: 'repo', name: 'Repo', url: 'https://example.test/repo' });
  const registry = new RecipeRegistry(store, { resolveReference: () => true, executionProfile: fixtureExecutionProfile, executionReadiness: () => [] });
  const recipe = registry.createCommand(boundRecipe(registry, { yaml: JSON.stringify(source), repositoryIds: ['repo'] }), { key: 'recipe' });
  const task = materializeTask({ recipeId: recipe.recipeId, repositoryIds: ['repo'], title: literal, description: literal }, recipe, 'repo', { ownerId: 'vscode', providerId: 'copilot', finishPolicy: 'pr' });
  const scope = { attemptId: 'attempt-1', recipeId: recipe.recipeId, recipeRevision: recipe.revision, repositoryIds: ['repo'], grantIds: ['fixture-grant'], expiresAt: '2099-01-01T00:00:00.000Z', fence: 1 };
  const native: WorkerRequest = { requestId: 'native-request', idempotencyKey: 'native-key', scope, operation: 'native.start', payload: { idempotencyKey: 'native-key', attemptId: 'attempt-1', task, workspacePath: '/fixture', baseSha: 'abc', fence: 1, profileId: 'fixture-only' } };
  const result: TaskResult = { attemptId: 'attempt-1', summary: literal, evidence: [literal], createdTaskIds: [], outcome: 'result' };
  const final: WorkerRequest = { requestId: 'result-request', idempotencyKey: 'result-key', scope: { ...scope, fence: 2 }, operation: 'result.submit', payload: result };
  const nativeReply = { requestId: 'native-request', ok: true as const, result: { ownerId: 'vscode', providerId: 'copilot' as const, sessionId: literal } };
  const finalReply = { requestId: 'result-request', ok: true as const, result };
  const fixtures = { '/worker/v1/native/start': { input: encodeWorkerRequest(native), reply: encodeWorkerResponse(nativeReply), authorization: 'Bearer fixture.start' }, '/worker/v1/results': { input: encodeWorkerRequest(final), reply: encodeWorkerResponse(finalReply), authorization: 'Bearer fixture.fresh' } };
  const brokerScript = `const http=require('node:http');const fixtures=${JSON.stringify(fixtures)};const count={};http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const f=fixtures[req.url];if(!f||body!==f.input||req.headers.authorization!==f.authorization){res.writeHead(400);res.end('mismatch');return;}count[req.url]=(count[req.url]||0)+1;require('node:fs').writeFileSync('/tmp/counts.json',JSON.stringify(count));res.setHeader('Content-Type','application/json');res.end(f.reply);}).listen(8080,'0.0.0.0');`;
  const data = await resource('volume', 'data'); const configVolume = await resource('volume', 'config'); const network = await resource('network', 'network');
  const config = parse(readFileSync(new URL('../runtime/kestra/application.yaml', import.meta.url), 'utf8'));
  config.kestra.server = { 'basic-auth': { username: secrets.username, password: secrets.password } }; config.kestra.encryption = { 'secret-key': secrets.encryptionKey };
  await docker.command(['run', '--rm', '-i', ...label, '--pull', 'never', '--network', 'none', '--mount', `type=volume,src=${data},dst=/data`, '--mount', `type=volume,src=${configVolume},dst=/config`, kestraImagePins.worker.image, 'node', '-e', `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const p=JSON.parse(s),fs=require('node:fs');fs.chownSync('/data',1000,1000);fs.writeFileSync('/config/application.yaml',JSON.stringify(p.config));fs.writeFileSync('/config/broker.cjs',p.brokerScript);});`], { stdin: JSON.stringify({ config, brokerScript }) });
  const broker = await container('broker', [...restrictions, '--network', network, '--network-alias', 'sf-broker', '--mount', `type=volume,src=${configVolume},dst=/fixture,readonly`, kestraImagePins.worker.image, 'node', '/fixture/broker.cjs']);
  const engine = await container('engine', [...restrictions, '--network', network, '--hostname', 'sf-kestra', '--add-host', 'sf-kestra:127.0.0.1', '--mount', `type=volume,src=${data},dst=/app/data`, '--mount', `type=volume,src=${configVolume},dst=/app/confs,readonly`, '--env', 'MICRONAUT_CONFIG_FILES=/app/confs/application.yaml', '--env', 'KESTRA_PLUGINS_AUTO_INSTALL_ENABLED=false', kestraImagePins.kestra.image, 'server', 'local']);
  const sidecar = await container('transport', [...restrictions, '--network', 'container:' + engine, kestraImagePins.worker.image, 'node', '-e', 'setInterval(()=>{},1000)']);
  const transport = createEngineTransport(docker, sidecar, secrets);
  async function ready() { for (let i = 0; i < 90; i++) { try { const r = await transport({ method: 'GET', path: '/executions/search?size=1' }); if (r.status === 200) return; } catch {} await sleep(); } throw Error('Pinned engine readiness deadline'); }
  await ready(); const denied = await createEngineTransport(docker, sidecar, { ...secrets, password: 'wrong-fixture-password' })({ method: 'GET', path: '/executions/search?size=1' }); assert.ok([401,403].includes(denied.status)); console.log('Pinned engine authenticated API ready; wrong credentials rejected');
  let drop = true;
  const options = { journalDirectory: root, request: async (r: Parameters<typeof transport>[0]) => { const response = await transport(r); if (drop && r.method === 'POST' && r.path.startsWith('/executions/') && r.path.includes('?revision=')) { console.log('Start HTTP status',response.status, response.status >= 300 ? JSON.stringify(response.body) : 'accepted'); drop = false; if(response.status<300)throw Error('fixture lost start reply'); } return response; }, authority: { start: async () => ({ request: native, capability: 'fixture.start' }), result: async () => ({ request: final, capability: 'fixture.fresh' }) } };
  client = new KestraClient(options);
  const start = { idempotencyKey: 'start', attemptId: 'attempt-1', recipe, inputs: {}, scopeId: 'scope', fence: 1 };
  let identity; for(let i=0;i<20;i++){try{identity=await client.ensureExecution(start);break;}catch(error){if(i===19)throw error;await sleep();}} assert.ok(identity);
  for (let i = 0; i < 60; i++) { if ((await client.snapshot(identity)).state === 'paused') break; await sleep(); }
  assert.equal((await client.snapshot(identity)).state, 'paused');
  const nativeOutput = await transport({ method: 'POST', path: `/executions/${identity.executionId}/actions/eval`, body: '{{ outputs.native_start.body }}' });
  assert.deepEqual(decodeWorkerResponse(nativeOutput.body.result), nativeReply);
  await docker.command(['restart', '--timeout', '30', engine]); await docker.command(['restart', '--timeout', '1', sidecar]); await ready();
  client.close(); client = new KestraClient(options); assert.deepEqual(await client.ensureExecution(start), identity); assert.equal((await client.snapshot(identity)).state, 'paused');
  await client.resumeInput(identity, result, 'resume');
  for (let i = 0; i < 60; i++) { if ((await client.snapshot(identity)).state === 'completed') break; await sleep(); }
  const snapshot = await client.snapshot(identity); assert.equal(snapshot.state, 'completed'); assert.deepEqual(snapshot.result, result);
  await client.resumeInput(identity, result, 'resume');
  const counts = JSON.parse(await docker.command(['exec', broker, 'node', '-e', `process.stdout.write(require('node:fs').readFileSync('/tmp/counts.json','utf8'))`]));
  assert.deepEqual(counts, { '/worker/v1/native/start': 1, '/worker/v1/results': 1 });
  assert.equal(await docker.command(['exec', engine, 'sh', '-c', 'test -s /app/data/database.mv.db && echo h2-persisted']), 'h2-persisted');
  receipt.identity = identity; receipt.assertions = ['basic-auth-wrong-credentials-rejected', 'production-client-lost-start-reply-single-execution', 'current-three-task-graph', 'native-body-rawtags-expressions-unicode-exact', 'native-reply-rawtags-expressions-unicode-exact', 'h2-pause-survives-restart', 'same-pinned-revision-after-client-restart', 'fresh-fence-result-capability', 'result-body-and-reply-exact', 'resume-key-idempotency', 'one-native-start-one-result', 'h2-file-present'];
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : 'unknown'; throw error; }
finally {
  client?.close(); store.close(); const cleanup: string[] = [];
  for (const resource of [...resources].reverse()) {
    try { const value = JSON.parse(await docker.command([resource.kind, 'inspect', resource.name]))[0]; assert.equal((value.Config?.Labels ?? value.Labels)?.['sf.e2.owner'], owner); await docker.command([resource.kind, 'rm', ...(resource.kind === 'container' ? ['--force'] : []), resource.name]); }
    catch { cleanup.push(resource.name); }
  }
  receipt.cleanup = cleanup.length ? { retained: cleanup } : 'complete';
  const path = process.env.SF_E2_RECEIPT ?? '/tmp/sf-task15-live-receipt.json'; writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(receipt, null, 2)); rmSync(root, { recursive: true, force: true });
  if (cleanup.length) process.exitCode = 1;
}

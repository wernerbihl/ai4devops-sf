import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProbeEvidence, ProbeOptions, RecipeContract } from '../src/contracts/domain.ts';
import { validateContract } from '../src/contracts/schemas.ts';
import { assertLiveScratch, ProbeBlocked, writeEvidence } from './common.ts';
import { OwnedDocker, restrictedArgs, verifyImagePins, images } from './docker.ts';
import { inspectRestrictions } from './isolation.ts';
import policy from '../release/recipe-policy.json' with { type: 'json' };

export interface KestraApi {
  request(method: string, path: string, body?: string, dropReply?: boolean): Promise<any>;
  restart(): Promise<void>;
}
export function makeProbeFlow(): RecipeContract {
  return { id: 'restricted', namespace: 'sf.p4', description: 'immutable revision one', variables: { sf: {
    schemaVersion: 1, recipeId: 'p4', displayName: 'P4 restricted proof', tagId: 'p4', inputSchema: { type: 'object' },
    taskTemplate: { title: 'Proof', description: 'Fixed diagnostic', goal: 'Verify boundaries', acceptanceCriteria: ['Fixed assertions pass'], skills: [], tools: [], context: {} },
    required: { paths: [], tools: [], networkDestinations: [], credentialRefs: [], allowedFinishPolicies: ['result'] },
    compatibleOwners: ['vscode'], compatibleProviders: ['copilot', 'codex'], defaultFinishPolicy: 'result',
  } }, tasks: [
    { id: 'approval', type: 'io.kestra.plugin.core.flow.Pause', onResume: [{ id: 'approved', type: 'BOOL', required: true }, { id: 'count', type: 'INT', required: true }] },
    { id: 'done', type: 'io.kestra.plugin.core.debug.Return', format: 'fixed-success' },
  ], outputs: [{ id: 'approved', type: 'BOOL', value: '{{ outputs.approval.onResume.approved }}' }, { id: 'count', type: 'INT', value: '{{ outputs.approval.onResume.count }}' }] };
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new ProbeBlocked('Recipe contains a non-allowlisted property');
}
/** Narrow feasibility policy, not a production recipe importer. Caller supplies parsed standard Kestra JSON/YAML. */
export function validateRecipePolicy(value: unknown): void {
  const flow = validateContract('RecipeContract', value);
  keys(flow, policy.flowKeys); keys(flow.variables, ['sf']);
  const scan = (v: unknown): void => {
    if (typeof v === 'string' && /\{[{%#]/.test(v)) throw new ProbeBlocked('Unsafe recipe interpolation');
    if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan({ ...flow, outputs: [] });
  for (const task of flow.tasks) {
    const allowed = policy.taskProperties[task.type as keyof typeof policy.taskProperties];
    if (!allowed) throw new ProbeBlocked('Recipe plugin/runner/subflow is not allowlisted');
    keys(task, allowed);
    if (task.type === 'io.kestra.plugin.core.flow.Pause') {
      if (!Array.isArray(task.onResume) || !task.onResume.length) throw new ProbeBlocked('Typed Pause inputs required');
      for (const input of task.onResume) {
        keys(input, ['id', 'type', 'required']);
        if (!policy.resumeTypes.includes(input.type) || typeof input.id !== 'string' || input.required !== true) throw new ProbeBlocked('Unsupported Pause input');
      }
    }
  }
  for (const output of flow.outputs ?? []) {
    keys(output, ['id', 'type', 'value']);
    if (!policy.expressions.includes(output.value as string) || !policy.resumeTypes.includes(output.type as string)) throw new ProbeBlocked('Unsafe output interpolation');
  }
}
function searchPath(key: string): string {
  return '/executions/search?' + new URLSearchParams({ size: '100', 'filters[namespace][EQUALS]': 'sf.p4', 'filters[flowId][EQUALS]': 'restricted', 'filters[labels][EQUALS][sf_attempt]': key });
}
/** After an uncertain start only reconcile. Never infer that no search result permits a resend. */
export async function recoverExecution(api: KestraApi, key: string, attempts = 40): Promise<any> {
  for (let n = 0; n < attempts; n++) {
    const found = await api.request('GET', searchPath(key));
    if (found.total > 1 || found.results?.length > 1) throw new ProbeBlocked('Ambiguous RF3 execution identity');
    if (found.total === 1 && found.results?.length === 1) {
      const execution = found.results[0];
      if (typeof execution.id !== 'string' || !execution.id || execution.namespace !== 'sf.p4' || execution.flowId !== 'restricted' ||
          !execution.labels?.some((label: any) => label.key === 'sf_attempt' && label.value === key)) throw new ProbeBlocked('RF3 lookup identity does not match the submitted attempt');
      return execution;
    }
    if (n + 1 < attempts) await delay(250);
  }
  throw new ProbeBlocked('Start outcome unknown; reconcile later without resending');
}
async function waitState(api: KestraApi, id: string, state: string, attempts: number): Promise<any> {
  for (let n = 0; n < attempts; n++) {
    const execution = await api.request('GET', `/executions/${id}`);
    if (execution?.state?.current === state) return execution;
    if (['FAILED', 'KILLED', 'CANCELLED'].includes(execution?.state?.current)) throw new Error('Execution reached failure state');
    if (n + 1 < attempts) await delay(250);
  }
  throw new Error('Durable execution state not observed');
}
export async function checkKestraLifecycle(api: KestraApi, key: string, attempts = 120) {
  const flow = makeProbeFlow(); validateRecipePolicy(flow);
  const created = await api.request('POST', '/flows', JSON.stringify(flow));
  assert.deepEqual(created.variables.sf, flow.variables.sf);
  assert.equal(created.revision, 1);
  await api.request('PUT', '/flows/sf.p4/restricted', JSON.stringify({ ...flow, description: 'revision two must not replace one' }));
  const revision = await api.request('GET', '/flows/sf.p4/restricted?revision=1');
  assert.equal(revision.description, 'immutable revision one'); assert.equal(revision.revision, 1);
  try { await api.request('POST', `/executions/sf.p4/restricted?revision=1&labels=${encodeURIComponent(`sf_attempt:${key}`)}`, '', true); }
  catch { /* RF3 transport deliberately discards the reply after submitting once. No retry. */ }
  const original = await recoverExecution(api, key, attempts);
  assert.equal(original.flowRevision, 1);
  const id = original.id;
  await waitState(api, id, 'PAUSED', attempts);
  await api.restart();
  const durable = await waitState(api, id, 'PAUSED', attempts);
  assert.equal(durable.id, id); assert.equal(durable.flowRevision, 1);
  const immutable = await api.request('GET', '/flows/sf.p4/restricted?revision=1');
  assert.deepEqual(immutable.variables.sf, flow.variables.sf); assert.equal(immutable.description, flow.description);
  const invalid = await api.request('POST', `/executions/${id}/actions/resume`, 'approved=true&count=not-an-integer');
  assert.ok([400, 422].includes(invalid.status), 'Malformed typed resume must be rejected');
  await waitState(api, id, 'PAUSED', attempts);
  await api.request('POST', `/executions/${id}/actions/resume`, 'approved=true&count=7');
  const completed = await waitState(api, id, 'SUCCESS', attempts);
  // Kestra 2.0 removed task/flow outputs from GET execution; evaluate the persisted Pause output.
  const evaluated = await api.request('POST', `/executions/${id}/actions/eval`, '{{ outputs.approval.onResume | toJson }}');
  const outputs = JSON.parse(evaluated.result);
  assert.equal(outputs.approved, true); assert.equal(outputs.count, 7);
  await api.restart();
  assert.equal((await waitState(api, id, 'SUCCESS', attempts)).id, id);
  const reconciled = await recoverExecution(api, key, attempts); assert.equal(reconciled.id, id);
  return { originalExecutionId: id, resumedExecutionId: completed.id, metadataAcceptedByPinnedKestra: true,
    assertions: ['variables.sf-accepted-unchanged', 'immutable-revision-lookup', 'rf3-lost-start-reply-single-execution', 'h2-pause-survives-restart', 'invalid-typed-resume-rejected', 'typed-resume-output-exact', 'same-execution-after-resume', 'h2-success-survives-second-restart'].map(name => ({ name, passed: true })) };
}

async function liveApi(docker: OwnedDocker, details: any): Promise<KestraApi> {
  const data = await docker.volume('h2');
  const config = await docker.volume('config');
  const configuration = JSON.stringify({ kestra: { server: { 'basic-auth': { username: 'probe@example.invalid', password: 'SfP4FixedCanary1' } }, plugins: { 'auto-install': { enabled: false } }, anonymousUsageReport: { enabled: false } } });
  const setup = await docker.run('h2-setup', ['--pull', 'never', '--network', 'none', '--mount', `type=volume,src=${data},dst=/data`, '--mount', `type=volume,src=${config},dst=/config`, images.worker.image, 'node', '-e', 'const fs=require("fs");fs.chownSync("/data",1000,1000);fs.writeFileSync("/config/application.yml",process.argv[1]);setInterval(()=>{},1000)', configuration]);
  await docker.command(['exec', setup, 'node', '-e', 'if(require("fs").statSync("/data").uid!==1000)process.exit(1)']);
  const server = await docker.run('kestra', [...restrictedArgs(), '--hostname', 'sf-kestra', '--add-host', 'sf-kestra:127.0.0.1', '--mount', `type=volume,src=${data},dst=/app/data`, '--mount', `type=volume,src=${config},dst=/app/confs,readonly`, '--env', 'MICRONAUT_CONFIG_FILES=/app/confs/application.yml', '--env', 'KESTRA_PLUGINS_AUTO_INSTALL_ENABLED=false', images.kestra.image, 'server', 'local']);
  const inspected = await docker.inspect(server); inspectRestrictions(inspected, [{ name: data, destination: '/app/data', readOnly: false }, { name: config, destination: '/app/confs', readOnly: true }]);
  details.effectiveSettings = { image: inspected.Config.Image, user: inspected.Config.User, readOnly: inspected.HostConfig.ReadonlyRootfs, network: inspected.HostConfig.NetworkMode, capDrop: inspected.HostConfig.CapDrop, securityOpt: inspected.HostConfig.SecurityOpt, mounts: inspected.Mounts.map((m: any) => ({ type: m.Type, name: m.Name, destination: m.Destination })) };
  const client = await docker.run('api-client', [...restrictedArgs(`container:${inspected.Id}`), images.worker.image, 'node', '-e', 'setInterval(()=>{},1000)']);
  inspectRestrictions(await docker.inspect(client), [], `container:${inspected.Id}`);
  const request: KestraApi['request'] = async (method, path, body, dropReply = false) => {
    const payload = Buffer.from(JSON.stringify({ method, path, body, dropReply })).toString('base64');
    const script = `const p=JSON.parse(Buffer.from(process.argv[1],'base64'));(async()=>{const h={Authorization:'Basic '+Buffer.from('probe@example.invalid:SfP4FixedCanary1').toString('base64')};let body=p.body;if(p.method!=='GET'){if(p.path.endsWith('/actions/eval'))h['Content-Type']='text/plain';else if(p.path.startsWith('/flows'))h['Content-Type']='application/x-yaml';else {body=new FormData();for(const [k,v]of new URLSearchParams(p.body??''))body.set(k,v);}}const r=await fetch('http://127.0.0.1:8080/api/v1/main'+p.path,{method:p.method,headers:h,...(p.method==='GET'?{}:{body}),signal:AbortSignal.timeout(15000)});const text=await r.text();if(p.dropReply){console.log(JSON.stringify({dropped:true,status:r.status}));return;}console.log(JSON.stringify({status:r.status,body:text?JSON.parse(text):null}));})().catch(()=>process.exit(1));`;
    const response = JSON.parse(await docker.command(['exec', client, 'node', '-e', script, payload]));
    if (response.dropped) { details.lostReply = { injected: true, httpStatusBeforeDiscard: response.status, controllerReceivedExecutionId: false }; throw new Error('Injected lost start reply'); }
    if (response.status >= 400) return { status: response.status };
    return response.body;
  };
  const ready = async () => {
    for (let n = 0; n < 90; n++) {
      try { const response = await request('GET', '/flows/search?size=1'); if (Array.isArray(response.results)) return; if ([401,403].includes(response.status)) throw new ProbeBlocked('Owned Kestra rejected fixed probe authentication'); }
      catch (error) { if (error instanceof ProbeBlocked && error.message.includes('authentication')) throw error; /* Startup only; no native retries. */ }
      const state = (await docker.inspect(server)).State;
      if (!state.Running) {
        const logs = await docker.command(['logs', '--tail', '100', server]);
        details.startupDiagnostic = logs.split('\n').filter(line => /Read-only file system|Permission denied|Exception|ERROR|mkdir|cannot create/.test(line)).slice(-12);
        throw new ProbeBlocked(`Owned Kestra exited during startup (exit ${state.ExitCode}); inspect setup requirements`);
      }
      await delay(1000);
    }
    throw new ProbeBlocked('Owned Kestra API did not become ready');
  };
  await ready();
  details.plugins = { core: images.kestra.version, additional: [], autoInstall: false };
  return { request, async restart() {
    await docker.command(['restart', '--timeout', '30', server]);
    // A Docker restart replaces network-none's namespace. Rejoin the new namespace before API checks.
    await docker.command(['restart', '--timeout', '1', client]);
    inspectRestrictions(await docker.inspect(client), [], `container:${inspected.Id}`);
    await ready();
    const h2 = await docker.command(['exec', server, 'sh', '-c', 'test -s /app/data/database.mv.db && echo h2-persisted']);
    if (h2 !== 'h2-persisted') throw new Error('H2 file persistence not observed');
    details.h2FileObserved = true;
  } };
}
export async function probeKestra(options: ProbeOptions): Promise<ProbeEvidence> {
  validateContract('ProbeOptions', options);
  const report: ProbeEvidence = { name: 'kestra-oss-h2', mode: options.mode, status: 'blocked', versions: {}, assertions: [], artifacts: [] };
  const details: any = { observedAt: new Date().toISOString(), productionOrchestratorImplemented: false };
  if (options.mode === 'fixture') {
    validateRecipePolicy(makeProbeFlow()); report.status = 'passed'; report.assertions.push({ name: 'fixture-recipe-policy', passed: true });
    return writeEvidence(options.outputDir, report, { reason: 'Policy fixture only; no actual H2 or native evidence' });
  }
  await assertLiveScratch(options);
  const docker = new OwnedDocker(options.outputDir); details.resourceOwner = docker.owner;
  try {
    await verifyImagePins(docker);
    report.versions = { docker: await docker.command(['version', '--format', '{{.Server.Version}}']), kestra: images.kestra.image, worker: images.worker.image };
    const api = await liveApi(docker, details);
    const results = await checkKestraLifecycle(api, docker.owner);
    Object.assign(details, results); report.assertions = results.assertions; report.status = 'passed';
  } catch (error) { report.status = error instanceof ProbeBlocked ? 'blocked' : 'failed'; details.reason = error instanceof ProbeBlocked ? error.message : (error as Error).message.slice(0, 500); }
  finally { try { await docker.cleanup(); details.cleanup = 'complete'; } catch (error) { details.cleanup = (error as Error).message; report.status = 'blocked'; } }
  return writeEvidence(options.outputDir, report, details);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, 'scratch-repo': { type: 'string' }, 'output-dir': { type: 'string', default: 'logs/probes/kestra' } } });
  if (!values['scratch-repo']) throw new Error('Supply --scratch-repo');
  const report = await probeKestra({ ...(values.live ? { mode: 'live' as const, allowLive: true as const } : { mode: 'fixture' as const, allowLive: false }), scratchRepo: values['scratch-repo'], outputDir: values['output-dir']! });
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1;
}

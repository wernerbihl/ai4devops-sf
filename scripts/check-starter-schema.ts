/** Developer-only, owned, offline schema check. Never executes a recipe/native session. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedDocker, restrictedArgs, verifyImagePins, images } from '../probes/docker.ts';
import { validateRecipe } from '../src/recipes/validate.ts';
const outputDir = resolve(process.argv[2] ?? 'release/evidence/e1/schema');
const docker = new OwnedDocker(outputDir);
const report: Record<string, unknown> = { mode: 'live', check: 'starter-schema-only', kestra: images.kestra, status: 'blocked', assertions: [] };
try {
  await verifyImagePins(docker);
  const data = await docker.volume('h2'); const config = await docker.volume('config');
  const password = randomBytes(24).toString('base64url');
  const configuration = JSON.stringify({ kestra: { server: { 'basic-auth': { username: 'schema@example.invalid', password } },
    encryption: { 'secret-key': randomBytes(32).toString('hex') }, variables: { 'recursive-rendering': false },
    plugins: { 'auto-install': { enabled: false } }, anonymousUsageReport: { enabled: false } } });
  await docker.run('setup', ['--pull', 'never', '--network', 'none', '--mount', `type=volume,src=${data},dst=/data`, '--mount', `type=volume,src=${config},dst=/config`, images.worker.image, 'node', '-e', 'const fs=require("fs");fs.chownSync("/data",1000,1000);fs.writeFileSync("/config/application.yml",process.argv[1]);setInterval(()=>{},1000)', configuration]);
  const server = await docker.run('kestra', [...restrictedArgs(), '--hostname', 'sf-kestra', '--add-host', 'sf-kestra:127.0.0.1',
    '--mount', `type=volume,src=${data},dst=/app/data`, '--mount', `type=volume,src=${config},dst=/app/confs,readonly`,
    '--env', 'MICRONAUT_CONFIG_FILES=/app/confs/application.yml', '--env', 'KESTRA_PLUGINS_AUTO_INSTALL_ENABLED=false', images.kestra.image, 'server', 'local']);
  const inspected = await docker.inspect(server);
  const client = await docker.run('client', [...restrictedArgs(`container:${inspected.Id}`), images.worker.image, 'node', '-e', 'setInterval(()=>{},1000)']);
  const request = async (method: string, path: string, body?: string): Promise<{ status: number; body: unknown }> => {
    const payload = Buffer.from(JSON.stringify({ method, path, body, password })).toString('base64');
    const script = `const p=JSON.parse(Buffer.from(process.argv[1],'base64'));(async()=>{const r=await fetch('http://127.0.0.1:8080/api/v1/main'+p.path,{method:p.method,headers:{Authorization:'Basic '+Buffer.from('schema@example.invalid:'+p.password).toString('base64'),'Content-Type':'application/x-yaml'},...(p.body===undefined?{}:{body:p.body}),signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status,body:await r.json()}));})().catch(()=>process.exit(1));`;
    return JSON.parse(await docker.command(['exec', client, 'node', '-e', script, payload]));
  };
  let ready = false;
  for (let n = 0; n < 45; n++) {
    try { if ((await request('GET', '/flows/search?size=1')).status === 200) { ready = true; break; } } catch { /* Bounded startup reads only. */ }
    if (!(await docker.inspect(server)).State.Running) throw new Error('Owned pinned Kestra exited during startup');
    await delay(1000);
  }
  assert.ok(ready, 'Owned pinned Kestra API became ready');
  report.assertions = [];
  for (const name of ['focused-feature', 'focused-bug-fix', 'scoped-quality']) {
    const yaml = await readFile(new URL(`../recipes/starter/${name}.yaml`, import.meta.url), 'utf8');
    const validated = validateRecipe(yaml, []);
    const response = await request('POST', '/flows/validate', yaml);
    (report.assertions as unknown[]).push({ name, hash: validated.hash, response });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body), 'Kestra returned validation records');
    assert.ok(response.body.length === 1 && response.body.every(item => !item.constraints && !item.outdated && !item.deprecationPaths?.length), 'Starter must have no schema constraints or deprecations');
  }
  report.status = 'passed';
} catch (error) { report.reason = error instanceof Error ? error.message : 'Unknown schema check failure'; process.exitCode = 1; }
finally {
  try { await docker.cleanup(); report.cleanup = 'complete'; } catch { report.cleanup = 'failed; inspect owned resource manifest'; report.status = 'blocked'; process.exitCode = 1; }
  await mkdir(outputDir, { recursive: true }); await writeFile(resolve(outputDir, 'starter-schema.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cleanup: report.cleanup, report: resolve(outputDir, 'starter-schema.json') }));
}

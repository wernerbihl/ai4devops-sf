import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { schemas } from '../src/contracts/schemas.ts';
import type { ContractName } from '../src/contracts/schemas.ts';

const ref = (name: ContractName) => ({ $ref: `#/components/schemas/${name}` });
const array = (name: ContractName) => ({ type: 'array', items: ref(name) });
type Boundary = 'BrowserSession' | 'AttemptBearer' | 'OwnerBridge';
type Method = 'get' | 'post' | 'patch' | 'delete';
const paths: Record<string, Partial<Record<Method, object>>> = {};
function route(method: Method, path: string, response: ContractName | object, options: {
  body?: ContractName; boundary?: Boundary; versioned?: boolean; description?: string; events?: boolean;
} = {}): void {
  const parameters: object[] = [];
  for (const parameter of path.matchAll(/\{(\w+)\}/g)) {
    parameters.push({ name: parameter[1], in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
  }
  if (method !== 'get') parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1 } });
  if (options.versioned) parameters.push({ name: 'If-Match', in: 'header', required: true,
    description: 'The current entity revision. Stale revisions are rejected without side effects.', schema: { type: 'string', minLength: 1 } });
  if (options.events) parameters.push({ name: 'Last-Event-ID', in: 'header', required: false,
    description: 'Resume cursor. An expired cursor returns STALE_CURSOR (409); refresh the snapshot without replaying actions.', schema: { type: 'string' } });
  const error = (description: string) => ({ description, content: { 'application/json': { schema: ref('ApiError') } } });
  const responses: Record<string, object> = {
    '200': { description: 'Success', content: { [options.events ? 'text/event-stream' : 'application/json']: {
      schema: typeof response === 'string' ? ref(response) : response,
    } } },
    '400': error('Invalid contract'), '401': error('Authentication required'), '403': error('Scope or grant denied'),
    '404': error('Resource not found'), '409': error('Stale revision or event cursor; refresh current state'),
    '429': error('Admission limit reached'), '503': error('Required capability or service unavailable'),
  };
  const operation = {
    operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    description: options.description ?? `${method.toUpperCase()} ${path}`,
    security: [{ [options.boundary ?? 'BrowserSession']: [] }], parameters, responses,
    ...(options.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(options.body) } } } } : {}),
  };
  (paths[path] ??= {})[method] = operation;
}
route('get', '/v1/health', 'Health');
route('get', '/v1/snapshot', 'FactorySnapshot');
route('get', '/v1/events', 'FactoryEvent', { events: true });
route('get', '/v1/settings', 'Settings');
route('patch', '/v1/settings', 'Settings', { body: 'SettingsPatch', versioned: true });
route('get', '/v1/repositories', array('Repository'));
route('patch', '/v1/repositories/{id}', 'Repository', { body: 'RepositoryPatch', versioned: true });
route('patch', '/v1/repositories/{id}/weights', 'Repository', { body: 'WeightsPatch', versioned: true });
route('get', '/v1/repositories/{id}/rotation-preview', 'RotationPreview');
route('post', '/v1/tags', 'Tag', { body: 'TagCreate' });
route('patch', '/v1/tags/{id}', 'Tag', { body: 'TagPatch', versioned: true });
route('delete', '/v1/tags/{id}', 'Acknowledgement', { versioned: true });
route('post', '/v1/tags/{id}/archive', 'Tag', { body: 'TagArchive', versioned: true });
route('get', '/v1/tasks', array('TaskRecord'));
route('post', '/v1/tasks', array('TaskRecord'), { body: 'CreateTaskRequest' });
route('get', '/v1/tasks/{id}', 'TaskRecord');
route('patch', '/v1/tasks/{id}', 'TaskRecord', { body: 'TaskPatch', versioned: true });
route('delete', '/v1/tasks/{id}', 'TaskRecord', { versioned: true, description: 'Cancel/archive live or history-bearing work; retain audit history.' });
route('get', '/v1/recipes', array('RecipeSummary'));
route('post', '/v1/recipes', 'RecipeRevision', { body: 'RecipeCreate' });
route('post', '/v1/recipes/validate', 'RecipeValidation', { body: 'RecipeCreate', description: 'Metadata validation plus pinned upstream Kestra and restricted-subset validation. Metadata validation alone cannot claim executable readiness.' });
route('post', '/v1/recipes/{id}/revisions', 'RecipeRevision', { body: 'RecipeCreate', versioned: true });
route('get', '/v1/recipes/{id}', 'RecipeRevision', { description: 'Retrieve the full current recipe revision, including YAML, contract, input defaults and repository assignments, so an existing recipe can be reloaded for editing without a preceding mutation.' });
route('patch', '/v1/recipes/{id}', 'RecipeSummary', { body: 'RecipePatch', versioned: true });
route('post', '/v1/dispatch', 'DispatchResult', { body: 'Empty' });
route('post', '/v1/attention/{id}/respond', 'AttentionRequest', { body: 'AttentionResponse', versioned: true });
route('post', '/v1/tasks/{id}/takeover', 'TaskRecord', { body: 'Empty', versioned: true });
route('post', '/v1/repositories/{id}/return-control', 'Repository', { body: 'Empty', versioned: true });
route('post', '/v1/tasks/{id}/open-native', 'NativeOpenResult', { body: 'Empty' });
route('post', '/v1/auth/probe', 'AuthState', { body: 'Empty' });
route('post', '/v1/auth/device-flow', 'DeviceFlow', { body: 'Empty', description: 'Start backend-owned GitHub App device flow. No browser-provided credential or client secret is accepted.' });
route('get', '/v1/auth/device-flow/{id}', 'DeviceFlow');
route('post', '/v1/auth/device-flow/{id}/complete', 'AuthState', { body: 'Empty', description: 'Backend polls/completes the documented device flow; the browser supplies only the opaque flow ID.' });
for (const [method, path] of [
  ['post', '/worker/v1/tasks'], ['get', '/worker/v1/tasks/{id}'], ['patch', '/worker/v1/tasks/{id}'],
  ['delete', '/worker/v1/tasks/{id}'], ['post', '/worker/v1/findings'], ['post', '/worker/v1/native/start'],
  ['post', '/worker/v1/native/continue'], ['post', '/worker/v1/results'], ['post', '/worker/v1/artifacts'],
  ['get', '/worker/v1/artifacts/{id}'], ['post', '/worker/v1/attention'],
] as const) {
  route(method, path, 'WorkerResponse', { boundary: 'AttemptBearer',
    ...(method !== 'get' ? { body: 'WorkerRequest' as const } : {}),
    description: 'Attempt-authenticated broker only. Verify expiry, recipe revision, repository scope, grants and current fence. Inherit recipe tag; never elevate finish authority or switch a running native identity. GET uses identity from the attempt credential.',
  });
}
route('post', '/owner/v1/rpc', 'OwnerRpcResponse', { body: 'OwnerRpc', boundary: 'OwnerBridge',
  description: 'Paired trusted native-owner bridge only. Browser sessions and worker credentials cannot register or impersonate a bridge. Request IDs correlate one-to-one NativeOwner methods; subscribe returns an authenticated stream subscription.',
});
// Reuse named definitions instead of duplicating the full task/attempt graph in every DTO.
const schemaNames = new Map<object, string>(Object.entries(schemas).map(([name, schema]) => [schema, name]));
function compact(value: unknown, root: object, prefix: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  const name = schemaNames.get(value);
  if (name && value !== root) return { $ref: `${prefix}${name}` };
  if (Array.isArray(value)) return value.map(item => compact(item, root, prefix));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child, root, prefix)]));
}
const definitions = (prefix: string) => Object.fromEntries(Object.entries(schemas)
  .map(([name, schema]) => [name, compact(schema, schema, prefix)]));
route('get', '/owner/v1/events/{subscriptionId}', 'OwnerEvent', { boundary: 'OwnerBridge', events: true,
  description: 'Authenticated native-owner subscription stream. Idle/activity never proves successful completion; reconnect by snapshot reconciliation.',
});
const openapi = {
  openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  info: { title: 'Local Software Factory protocol', version: '1.0.0',
    description: 'Version 1 contracts. Credentials remain backend-owned. Capability evidence and authorization are checked at use, never inferred from a schema or idle event.' },
  servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: '4317' } } }],
  paths,
  components: {
    securitySchemes: {
      BrowserSession: { type: 'apiKey', in: 'cookie', name: 'sf_session', description: 'Protected local session; enforce allowed origins and CSRF protections on mutations.' },
      AttemptBearer: { type: 'http', scheme: 'bearer', description: 'Short-lived, attempt-scoped worker credential bound to recipe, repositories, grants, expiry and fence.' },
      OwnerBridge: { type: 'http', scheme: 'bearer', description: 'OS-user-paired trusted native-owner bridge credential. Never issued by browser/admin or worker operations.' },
    }, schemas: definitions('#/components/schemas/'),
  },
};
const bundle = { $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ai4devops-sf:protocol:1', title: 'Factory protocol v1', $defs: definitions('#/$defs/') };
const directory = new URL('../protocol/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, value] of [['openapi.json', openapi], ['schemas.json', bundle]] as const) {
  const expected = JSON.stringify(value, null, 2) + '\n';
  const file = new URL(name, directory);
  if (process.argv.includes('--check')) {
    const actual = await readFile(file, 'utf8').catch(() => '');
    if (actual !== expected) throw new Error(`Protocol drift in ${name}; run npm run protocol:generate`);
  } else await writeFile(file, expected);
}

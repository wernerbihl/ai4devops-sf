import type { RecipeContract } from '../contracts/domain.ts';
import { canonical } from '../storage/database.ts';

export const PUBLIC_BROKER_AUTHORIZATION = Object.freeze([
  'Bearer {{ inputs.sf_capability }}',
  'Bearer {{ outputs.await_result.onResume.sf_result_capability }}',
]);

export class RecipePolicyError extends Error {
  readonly field: string;
  constructor(field: string, message: string) { super(message); this.name = 'RecipePolicyError'; this.field = field; }
}
export function requirePolicy(ok: unknown, field: string, message: string): asserts ok {
  if (!ok) throw new RecipePolicyError(field, message);
}
export function allowedKeys(value: Record<string, unknown>, keys: string[], field: string): void {
  for (const key of Object.keys(value)) requirePolicy(keys.includes(key), `${field}/${key}`, 'Property is outside the restricted recipe policy');
}
const reference = /\{\{\s*(title|description|inputs\.[A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
export function templateReferences(value: unknown, inputs: Set<string>, field = '/variables/sf/taskTemplate'): void {
  if (typeof value === 'string') {
    const rest = value.replace(reference, (_match, name: string) => {
      requirePolicy(!name.startsWith('inputs.') || inputs.has(name.slice(7)), field, 'Template references an undeclared input'); return '';
    });
    requirePolicy(!/\{[{%#]|[%#}]\}/.test(rest), field, 'Unsafe template expression');
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { requirePolicy(!/[{}]/.test(key), field, 'Template keys must be literal'); templateReferences(child, inputs, `${field}/${key}`); }
  }
}
export function renderTemplate(value: unknown, inputs: Record<string, unknown>, title: string, description: string): unknown {
  const lookup = (name: string) => name === 'title' ? title : name === 'description' ? description : inputs[name.slice(7)];
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*(title|description|inputs\.[A-Za-z][A-Za-z0-9_]*)\s*\}\}$/);
    if (exact) { const item = lookup(exact[1]!); requirePolicy(item !== undefined, '/inputs', `Missing template input ${exact[1]}`); return structuredClone(item); }
    return value.replace(reference, (_match, name: string) => {
      const item = lookup(name); requirePolicy(item !== undefined, '/inputs', `Missing template input ${name}`);
      return typeof item === 'string' ? item : JSON.stringify(item);
    });
  }
  if (Array.isArray(value)) return value.map(item => renderTemplate(item, inputs, title, description));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplate(item, inputs, title, description)]));
  return value;
}
/** Bounded JSON Schema subset: local data only, no refs, regex evaluation, extensions or remote loading. */
export function validateInputSchema(schema: Record<string, unknown>, field = '/variables/sf/inputSchema', depth = 0): void {
  requirePolicy(depth < 24, field, 'Input schema nesting exceeds 24');
  allowedKeys(schema, ['type', 'properties', 'items', 'required', 'additionalProperties', 'default', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description'], field);
  requirePolicy(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(schema.type)), field, 'Input schema requires a supported type');
  if (schema.type === 'object') {
    requirePolicy(schema.additionalProperties === false, field, 'Object inputs must reject undeclared properties');
    requirePolicy(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), field, 'Object input properties are required');
    for (const [name, value] of Object.entries(schema.properties as object)) {
      requirePolicy(/^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !name.startsWith('sf_') && !['__proto__', 'constructor', 'prototype'].includes(name), `${field}/${name}`, 'Reserved or invalid input name');
      requirePolicy(value && typeof value === 'object' && !Array.isArray(value), field, 'Input property must be a schema'); validateInputSchema(value as Record<string, unknown>, `${field}/properties/${name}`, depth + 1);
    }
  }
  if (schema.type === 'array') {
    requirePolicy(schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items), field, 'Array input requires an item schema');
    validateInputSchema(schema.items as Record<string, unknown>, `${field}/items`, depth + 1);
  }
}

/** Standard Kestra tasks, not a second workflow language. Only trusted runtime supplies these inputs. */
export function brokerEngineContract(): Pick<RecipeContract, 'inputs' | 'tasks'> {
  const http = (id: string, path: string, token: string, body: string) => ({
    id, type: 'io.kestra.plugin.core.http.Request', uri: `http://sf-broker:8080/worker/v1/${path}`,
    method: 'POST', contentType: 'application/json', headers: { Authorization: `Bearer {{ ${token} }}` }, body,
    options: { followRedirects: false, allowFailed: false, allowedResponseCodes: [200] },
  });
  return {
    inputs: [{ id: 'sf_capability', type: 'SECRET', required: true }, { id: 'sf_native_start', type: 'STRING', required: true }],
    tasks: [
      http('native_start', 'native/start', 'inputs.sf_capability', '{{ inputs.sf_native_start }}'),
      { id: 'await_result', type: 'io.kestra.plugin.core.flow.Pause', onResume: [
        { id: 'sf_result', type: 'STRING', required: true }, { id: 'sf_result_capability', type: 'SECRET', required: true },
      ] },
      http('submit_result', 'results', 'outputs.await_result.onResume.sf_result_capability', '{{ outputs.await_result.onResume.sf_result }}'),
    ],
  };
}
export function isBrokerFlow(flow: RecipeContract): boolean {
  const expected = brokerEngineContract();
  return canonical(flow.inputs) === canonical(expected.inputs) && canonical(flow.tasks) === canonical(expected.tasks) && !flow.outputs?.length;
}

/** P4-compatible Pause/Return subset. Production broker graph is separately constrained below. */
export function validateEnginePolicy(flow: RecipeContract): void {
  allowedKeys(flow, ['id', 'namespace', 'description', 'inputs', 'variables', 'tasks', 'outputs'], '');
  requirePolicy(/^[a-zA-Z0-9_-]+$/.test(flow.id) && /^[a-z0-9_.-]+$/.test(flow.namespace), '/id', 'Invalid Kestra flow identity');
  allowedKeys(flow.variables, ['sf'], '/variables');
  requirePolicy(!/\{[{%#]/.test(canonical({ id: flow.id, namespace: flow.namespace, description: flow.description })), '', 'Unsafe engine interpolation');
  if (flow.inputs?.length || flow.tasks.some(task => task.type === 'io.kestra.plugin.core.http.Request')) {
    requirePolicy(isBrokerFlow(flow), '/tasks', 'Broker flow must exactly match the restricted native/result ABI');
    return;
  }
  const ids = new Set<string>(); const pauseInputs = new Map<string, Record<string, unknown>[]>();
  for (const [index, task] of flow.tasks.entries()) {
    const field = `/tasks/${index}`;
    requirePolicy(typeof task.id === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(task.id) && !ids.has(task.id), field, 'Task IDs must be valid and unique'); ids.add(task.id);
    if (task.type === 'io.kestra.plugin.core.flow.Pause') {
      allowedKeys(task, ['id', 'type', 'onResume'], field);
      requirePolicy(Array.isArray(task.onResume) && task.onResume.length > 0, field, 'Pause requires typed resume inputs');
      const names = new Set();
      for (const input of task.onResume) {
        requirePolicy(input && typeof input === 'object', field, 'Malformed resume input');
        allowedKeys(input, ['id', 'type', 'required'], field);
        requirePolicy(typeof input.id === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(input.id) && !names.has(input.id) && ['BOOL', 'INT', 'STRING'].includes(input.type) && input.required === true, field, 'Unsupported Pause input'); names.add(input.id);
      }
      pauseInputs.set(task.id, task.onResume);
    } else if (task.type === 'io.kestra.plugin.core.debug.Return') {
      allowedKeys(task, ['id', 'type', 'format'], field);
      requirePolicy(typeof task.format === 'string' && !/\{[{%#]/.test(task.format), field, 'Return requires literal text');
    } else requirePolicy(false, `${field}/type`, 'Plugin, runner, image, script or subflow is not allowlisted');
  }
  for (const [index, output] of (flow.outputs ?? []).entries()) {
    const field = `/outputs/${index}`; allowedKeys(output, ['id', 'type', 'value'], field);
    const match = typeof output.value === 'string' && output.value.match(/^\{\{ outputs\.([A-Za-z][A-Za-z0-9_]*)\.onResume\.([A-Za-z][A-Za-z0-9_]*) \}\}$/);
    requirePolicy(match && pauseInputs.get(match[1]!)?.some(input => input.id === match[2] && input.type === output.type), field, 'Output must reference an existing typed Pause input');
  }
  const safe = { id: flow.id, namespace: flow.namespace, description: flow.description };
  requirePolicy(!/\{[{%#]/.test(canonical(safe)), '', 'Unsafe engine interpolation');
}

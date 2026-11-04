import type { FactorySnapshot } from '../contracts/domain.ts';
import type { ApiDeps } from './api.ts';
import { validateContract } from '../contracts/schemas.ts';
/** Defense in depth: adapters return DTOs, never raw credential/error/process objects. */
export function sanitize<T>(value: T, secrets: readonly string[] = []): T {
  const sensitive = /^(access_?token|refresh_?token|authorization|password|secret|client_?secret|cookie|csrfToken|deviceCode)$/i;
  const schemaContainers = new Set(['schema', 'inputSchema', 'outputSchema']);
  const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
  const schemaChildren = new Set(['items', 'contains', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'if', 'then', 'else', 'not', 'unevaluatedItems', 'additionalItems', 'contentSchema']);
  const schemaLists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  const identifiers = new Set(['type', '$ref', '$dynamicRef', '$schema', '$id', '$anchor', '$dynamicAnchor', 'format', 'pattern', 'contentEncoding', 'contentMediaType', 'required', 'dependentRequired']);
  const cleanString = (item: string): string => {
    let result = item.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
    for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
    return result;
  };
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  const cleanSchema = (item: unknown, sensitiveNode = false): unknown => {
    if (Array.isArray(item)) return item.map(child => cleanSchema(child, sensitiveNode));
    if (!object(item)) return clean(item);
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
      // These map keys and reference/required values name fields, not credential instances.
      if (schemaMaps.has(key) && object(entry)) return [key, Object.fromEntries(Object.entries(entry).map(([name, node]) => [name, cleanSchema(node, sensitiveNode || sensitive.test(name))]))];
      if (key === 'dependencies' && object(entry)) return [key, Object.fromEntries(Object.entries(entry).map(([name, node]) => [name, Array.isArray(node) ? structuredClone(node) : cleanSchema(node, sensitiveNode || sensitive.test(name))]))];
      if (schemaChildren.has(key) || schemaLists.has(key)) return [key, cleanSchema(entry, sensitiveNode)];
      if (identifiers.has(key)) return [key, structuredClone(entry)];
      if (key === 'default' || key === 'example') return [key, sensitiveNode ? '[redacted]' : clean(entry)];
      if (key === 'examples' && Array.isArray(entry)) return [key, entry.map(example => sensitiveNode ? '[redacted]' : clean(example))];
      // Annotation instances and unknown fields still receive normal credential redaction.
      return [key, clean(entry, key)];
    }));
  };
  const clean = (item: unknown, key = ''): unknown => {
    if (sensitive.test(key)) return '[redacted]';
    if (schemaContainers.has(key) && (object(item) || typeof item === 'boolean')) return cleanSchema(item);
    if (typeof item === 'string') return cleanString(item);
    if (Array.isArray(item)) return item.map(child => clean(child));
    if (object(item)) return Object.fromEntries(Object.entries(item).map(([k, v]) => [cleanString(k), clean(v, k)]));
    return item;
  };
  return clean(value) as T;
}
export async function factorySnapshot(deps: ApiDeps): Promise<FactorySnapshot> {
  // Read external readiness first: the SQLite snapshot and cursor are captured together afterwards.
  const health = deps.health ? await deps.health() : { schemaVersion: 1 as const, ready: false, reasons: ['Connect the factory runtime readiness adapter'], version: '0.1.0' };
  const auth = deps.auth ? await deps.auth.state() : { status: 'unavailable' as const, reasons: ['Connect the GitHub authentication adapter'] };
  return validateContract('FactorySnapshot', sanitize({ ...deps.store.snapshot(), health: validateContract('Health', health), auth: validateContract('AuthState', auth) }, deps.secrets?.()));
}

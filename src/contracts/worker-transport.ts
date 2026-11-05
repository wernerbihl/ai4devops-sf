import type { WorkerRequest, WorkerResponse } from './domain.ts';
import { validateContract } from './schemas.ts';

/** Resource bounds for one transport message, not a context/token budget. Oversize messages fail; nothing is truncated. */
export const WORKER_TRANSPORT_MAX_WIRE_BYTES = 8 * 1024 * 1024;
export const WORKER_TRANSPORT_MAX_DECODED_BYTES = 6 * 1024 * 1024;
export const WORKER_TRANSPORT_ENCODING = 'sf-base64url-json-v1';
export class WorkerTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkerTransportError'; }
}
function requireTransport(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkerTransportError(message);
}
type JsonWork = { kind: 'value'; value: unknown } | { kind: 'text'; text: string } | { kind: 'leave'; value: object };
/** Iterative, bounded JSON serialization. Rejects lossy JS-only values, accessors and cycles instead of altering them. */
function logicalJson(value: unknown): string {
  const work: JsonWork[] = [{ kind: 'value', value }]; const active = new Set<object>();
  const chunks: string[] = []; let bytes = 0;
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8');
    requireTransport(bytes <= WORKER_TRANSPORT_MAX_DECODED_BYTES, 'Worker transport decoded byte limit exceeded'); chunks.push(text);
  };
  const string = (text: string) => {
    requireTransport(Buffer.byteLength(text, 'utf8') <= WORKER_TRANSPORT_MAX_DECODED_BYTES, 'Worker transport decoded byte limit exceeded');
    return JSON.stringify(text);
  };
  while (work.length) {
    const item = work.pop()!;
    if (item.kind === 'text') { emit(item.text); continue; }
    if (item.kind === 'leave') { active.delete(item.value); continue; }
    const current = item.value;
    if (current === null) { emit('null'); continue; }
    if (typeof current === 'string') { emit(string(current)); continue; }
    if (typeof current === 'boolean') { emit(current ? 'true' : 'false'); continue; }
    if (typeof current === 'number') {
      requireTransport(Number.isFinite(current), 'Worker transport requires finite JSON numbers'); emit(Object.is(current, -0) ? '-0' : JSON.stringify(current)); continue;
    }
    requireTransport(typeof current === 'object', 'Worker transport requires JSON data');
    requireTransport(!active.has(current), 'Worker transport rejects cyclic data');
    const array = Array.isArray(current); const proto = Object.getPrototypeOf(current);
    requireTransport(array || proto === Object.prototype || proto === null, 'Worker transport requires plain JSON data');
    const keys = Reflect.ownKeys(current).filter(key => !array || key !== 'length');
    const entries = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      requireTransport(typeof key === 'string' && descriptor.enumerable && 'value' in descriptor, 'Worker transport rejects non-JSON properties');
      return [key, descriptor.value] as const;
    });
    if (array) requireTransport(entries.length === current.length && entries.every(([key], index) => key === String(index)), 'Worker transport rejects sparse or decorated arrays');
    active.add(current); work.push({ kind: 'leave', value: current });
    emit(array ? '[' : '{'); work.push({ kind: 'text', text: array ? ']' : '}' });
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, entry] = entries[index]!; work.push({ kind: 'value', value: entry });
      if (!array) work.push({ kind: 'text', text: string(key) + ':' });
      if (index > 0) work.push({ kind: 'text', text: ',' });
    }
  }
  return chunks.join('');
}
function encode(name: 'WorkerRequest' | 'WorkerResponse', value: unknown): string {
  const json = logicalJson(value);
  try { validateContract(name, value); } catch { throw new WorkerTransportError(`Invalid logical ${name}`); }
  const wire = JSON.stringify({ encoding: WORKER_TRANSPORT_ENCODING, payload: Buffer.from(json, 'utf8').toString('base64url') });
  requireTransport(Buffer.byteLength(wire, 'utf8') <= WORKER_TRANSPORT_MAX_WIRE_BYTES, 'Worker transport wire byte limit exceeded');
  return wire;
}
function decode(name: 'WorkerRequest' | 'WorkerResponse', wire: string): WorkerRequest | WorkerResponse {
  requireTransport(typeof wire === 'string' && Buffer.byteLength(wire, 'utf8') <= WORKER_TRANSPORT_MAX_WIRE_BYTES, 'Worker transport wire byte limit exceeded or invalid body');
  let envelope: ReturnType<typeof parseEnvelope>;
  try { envelope = parseEnvelope(wire); } catch { throw new WorkerTransportError('Invalid canonical worker transport envelope'); }
  requireTransport(wire === JSON.stringify({ encoding: envelope.encoding, payload: envelope.payload }), 'Invalid canonical worker transport envelope');
  const bytes = Buffer.from(envelope.payload, 'base64url');
  requireTransport(bytes.toString('base64url') === envelope.payload, 'Worker transport requires canonical base64url');
  requireTransport(bytes.byteLength <= WORKER_TRANSPORT_MAX_DECODED_BYTES, 'Worker transport decoded byte limit exceeded');
  let json: string;
  try { json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new WorkerTransportError('Worker transport requires valid UTF-8'); }
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new WorkerTransportError('Invalid logical worker JSON'); }
  requireTransport(logicalJson(value) === json, 'Worker transport requires canonical logical JSON');
  // Never unwrap recursively: a nested transport wrapper is not a logical WorkerRequest/WorkerResponse.
  try { return validateContract(name, value); } catch { throw new WorkerTransportError(`Invalid logical ${name}`); }
}
function parseEnvelope(wire: string) { return validateContract('WorkerTransport', JSON.parse(wire)); }

/** E2 injects this exact string into sf_native_start / sf_result. E3 validates and authorizes after decoding. */
export function encodeWorkerRequest(value: WorkerRequest): string { return encode('WorkerRequest', value); }
export function decodeWorkerRequest(wire: string): WorkerRequest { return decode('WorkerRequest', wire) as WorkerRequest; }
/** E3 replies use the same opaque envelope; E2/E6 decodes only outside Kestra rendering. */
export function encodeWorkerResponse(value: WorkerResponse): string { return encode('WorkerResponse', value); }
export function decodeWorkerResponse(wire: string): WorkerResponse { return decode('WorkerResponse', wire) as WorkerResponse; }

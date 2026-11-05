import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskResult, TaskSpec, WorkerRequest, WorkerResponse } from '../../src/contracts/domain.ts';
import { recipeFixture, scopeFixture } from '../helpers/fixtures.ts';
import { decodeWorkerRequest, decodeWorkerResponse, encodeWorkerRequest, encodeWorkerResponse,
  WORKER_TRANSPORT_MAX_WIRE_BYTES, WORKER_TRANSPORT_MAX_DECODED_BYTES } from '../../src/contracts/worker-transport.ts';

const text = [
  '{% raw %}literal{% endraw %}', '{%- raw -%}{{ untouched }}{%- endraw -%}',
  '{{ secret("NEVER_EVALUATE") }}', '% and {% arbitrary %}', 'quotes " and \\ backslash',
  'line one\nline two\r\ntab\tend', 'Unicode 日本語 café 🙂 \u2028 separator',
  String.raw`literal \n \u00e9 \ud83d\ude42 \\ and \"`, '\ud800',
].join('\n');
function nativeRequest(): WorkerRequest {
  const metadata = recipeFixture('tag').contract.variables.sf;
  const task: TaskSpec = { ...metadata.taskTemplate, id: 'task', repositoryId: 'repo-1', recipeId: 'recipe-1', recipeRevision: 'rev-1', tagId: 'tag',
    source: 'manual', finishPolicy: 'result', ownerId: 'vscode', providerId: 'copilot', required: metadata.required,
    context: { text, array: [null, false, 0, text], nested: { literal: text } } };
  return { requestId: 'native-request', idempotencyKey: 'native-key', scope: scopeFixture(), operation: 'native.start',
    payload: { idempotencyKey: 'start-key', attemptId: 'attempt-1', task, workspacePath: '/managed/task', baseSha: 'abc', fence: 1, profileId: 'profile' } };
}
function resultValue(): TaskResult { return { attemptId: 'attempt-1', summary: text, evidence: [text], createdTaskIds: [], outcome: 'result' }; }
function envelope(payload: string): string { return JSON.stringify({ encoding: 'sf-base64url-json-v1', payload }); }
// Exact pinned VariableRenderer RAW_PATTERN postprocessing, an explicit external-source fixture, not a live engine claim.
const rawPostprocessing = (wire: string) => wire.replace(/(\{%-*\s*raw\s*-*%}(.*?)\{%-*\s*endraw\s*-*%})/g, '$2');

test('opaque_native_result_and_reply_transport_preserves_every_literal_through_raw_postprocessing', () => {
  const native = nativeRequest();
  const result: WorkerRequest = { requestId: 'result-request', idempotencyKey: 'result-key', scope: scopeFixture(), operation: 'result.submit', payload: resultValue() };
  for (const request of [native, result]) {
    const wire = encodeWorkerRequest(request);
    assert.equal(/[\x80-\uffff]|\{[{%#]|[%#}]\}/.test(wire), false);
    assert.equal(rawPostprocessing(wire), wire);
    assert.deepEqual(decodeWorkerRequest(rawPostprocessing(wire)), request);
    assert.equal(Buffer.from(JSON.parse(wire).payload, 'base64url').toString('utf8'), JSON.stringify(request));
  }
  const replies: WorkerResponse[] = [
    { requestId: 'result-request', ok: true, result: resultValue() },
    { requestId: 'native-request', ok: true, result: { ownerId: 'vscode', providerId: 'copilot', sessionId: text } },
    { requestId: 'result-request', ok: false, error: { code: 'ERROR', message: text, recovery: text, retryable: false } },
  ];
  for (const reply of replies) {
    const wire = encodeWorkerResponse(reply);
    assert.deepEqual(decodeWorkerResponse(rawPostprocessing(wire)), reply);
    assert.equal(rawPostprocessing(wire), wire);
  }
  // A plain JSON/toJson body would lose literal user text even in nonrecursive mode.
  assert.notEqual(rawPostprocessing(JSON.stringify(native)), JSON.stringify(native));
});

test('codec_rejects_noncanonical_malformed_nested_and_wrong_logical_envelopes', () => {
  const native = nativeRequest(); const wire = encodeWorkerRequest(native); const payload = JSON.parse(wire).payload as string;
  const malformed = [
    ` ${wire}`, wire.replace('sf-base64url-json-v1', 'sf-base64url-json-v2'),
    JSON.stringify({ encoding: 'sf-base64url-json-v1', payload, extra: true }),
    JSON.stringify({ payload, encoding: 'sf-base64url-json-v1' }),
    `{"encoding":"sf-base64url-json-v1","encoding":"sf-base64url-json-v1","payload":"${payload}"}`,
    envelope(payload + '='), envelope('+/invalid'), envelope(''),
    envelope(Buffer.from(wire).toString('base64url')),
    encodeWorkerResponse({ requestId: 'reply', ok: true, result: null }),
    envelope(Buffer.from(JSON.stringify(native).replace('{"requestId":', '{"requestId":"shadow","requestId":')).toString('base64url')),
  ];
  for (const input of malformed) assert.throws(() => decodeWorkerRequest(input));
  assert.throws(() => decodeWorkerRequest(envelope('Zh')), /canonical base64url/);
  assert.throws(() => decodeWorkerRequest(envelope(Buffer.from([0xc3, 0x28]).toString('base64url'))), /UTF-8/);
  assert.throws(() => decodeWorkerRequest(envelope(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(native))]).toString('base64url'))));
  // Envelope-shaped values inside ordinary context are data, never recursively decoded.
  const nestedData = nativeRequest();
  if (nestedData.operation !== 'native.start') throw new Error('fixture');
  nestedData.payload.task.context = { nested: JSON.parse(encodeWorkerResponse({ requestId: 'nested', ok: true, result: null })) };
  assert.deepEqual(decodeWorkerRequest(encodeWorkerRequest(nestedData)), nestedData);
  assert.throws(() => decodeWorkerResponse(wire));
  assert.throws(() => encodeWorkerRequest({ ...native, operation: 'admin.activate' } as unknown as WorkerRequest));
});

test('codec_bounds_transport_resources_and_rejects_non_json_without_truncation', () => {
  assert.throws(() => decodeWorkerRequest('x'.repeat(WORKER_TRANSPORT_MAX_WIRE_BYTES + 1)), /wire.*limit/);
  // Oversized decoded content also exceeds the envelope limit; reject before parsing the logical body.
  assert.throws(() => decodeWorkerRequest(envelope(Buffer.alloc(WORKER_TRANSPORT_MAX_DECODED_BYTES + 1, 32).toString('base64url'))), /limit/);
  const request = nativeRequest(); assert.equal(request.operation, 'native.start');
  if (request.operation !== 'native.start') throw new Error('fixture');
  request.payload.task.context = 'x'.repeat(WORKER_TRANSPORT_MAX_DECODED_BYTES + 1);
  assert.throws(() => encodeWorkerRequest(request), /decoded.*limit/);
  for (const context of [undefined, NaN, Infinity, { missing: undefined }, [undefined], new Date(), 1n]) {
    request.payload.task.context = context;
    assert.throws(() => encodeWorkerRequest(request));
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; request.payload.task.context = cycle;
  assert.throws(() => encodeWorkerRequest(request), /cyclic/);
  request.payload.task.context = { data: 'large literal '.repeat(50000) };
  assert.deepEqual(decodeWorkerRequest(encodeWorkerRequest(request)), request);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ChatInputRequest } from '@microsoft/agent-host-protocol';
const request = { id: 'original-question', questions: [{ kind: 'text', id: 'name', message: 'Name', required: true, min: 2 }, { kind: 'integer', id: 'count', message: 'Count', required: true, min: 1, max: 5 }, { kind: 'boolean', id: 'confirmed', message: 'Confirm', required: true }, { kind: 'single-select', id: 'one', message: 'One', options: [{ id: 'a', label: 'A' }] }, { kind: 'multi-select', id: 'many', message: 'Many', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], min: 1, max: 2 }] } as ChatInputRequest;
async function implementation() { const m = await import('../../src/owners/input.ts').catch(() => undefined); assert.ok(m?.nativeInputSchema, 'Native questions require actual JSON Schema and C4 answer translation'); return m; }
test('I2 native input schema rejects invalid reply envelopes before attention is consumed', async () => {
    const m = await implementation();
    const validate = new Ajv2020({ strict: false }).compile(m.nativeInputSchema(request));
    for (const value of [{}, { response: 'accept' }, { response: 'accept', answers: {} }, { response: 'accept', answers: { name: 'A', count: 1, confirmed: true } }, { response: 'accept', answers: { name: 'Ada', count: 1.5, confirmed: true } }, { response: 'accept', answers: { name: 'Ada', count: 1, confirmed: 'yes' } }, { response: 'accept', answers: { name: 'Ada', count: 1, confirmed: true, one: 'unknown' } }, { response: 'accept', answers: { name: 'Ada', count: 1, confirmed: true, many: ['a', 'a'] } }, { response: 'cancel', requestId: 'forged' }])
        assert.equal(validate(value), false, JSON.stringify(value));
    assert.equal(validate({ response: 'decline' }), true);
    assert.equal(validate({ response: 'cancel' }), true);
    const value = { response: 'accept', answers: { name: 'Ada', count: 2, confirmed: true, one: 'a', many: ['a', 'b'] } };
    assert.equal(validate(value), true);
    const native = m.nativeInputReply(request, { requestId: request.id, response: value, answers: value });
    assert.equal(native.response, 'accept');
    assert.deepEqual(native.answers.name, { state: 'submitted', value: { kind: 'text', value: 'Ada' } });
    assert.deepEqual(native.answers.many, { state: 'submitted', value: { kind: 'selected-many', value: ['a', 'b'] } });
});
test('I2 unsupported questions fail before publication and supported freeform values map explicitly', async () => {
    const m = await implementation();
    assert.throws(() => m.nativeInputSchema({ id: 'q', questions: [{ id: 'file', kind: 'file', message: 'Unsupported' }] } as any), /Unsupported/);
    assert.throws(() => m.nativeInputSchema({ id: 'q', questions: [{ id: 'a', kind: 'text', message: 'Format', format: 'invented' }] } as any), /Unsupported/);
    const r = { id: 'q', questions: [{ id: 'one', kind: 'single-select', message: 'One', required: true, options: [{ id: 'a', label: 'A' }], allowFreeformInput: true }, { id: 'many', kind: 'multi-select', message: 'Many', options: [{ id: 'a', label: 'A' }], allowFreeformInput: true }] } as ChatInputRequest;
    const value = { response: 'accept', answers: { one: { text: 'new' }, many: { choices: ['a'], freeform: ['extra'] } } };
    const actual = m.nativeInputReply(r, { response: value, answers: value });
    assert.deepEqual(actual.answers.one, { state: 'submitted', value: { kind: 'selected', value: '', freeformValues: ['new'] } });
    assert.deepEqual(actual.answers.many, { state: 'submitted', value: { kind: 'selected-many', value: ['a'], freeformValues: ['extra'] } });
});

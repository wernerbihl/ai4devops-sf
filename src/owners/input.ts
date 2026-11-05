import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import type { ChatInputAnswer, ChatInputQuestion, ChatInputRequest, ChatInputResponseKind, ChatState } from '@microsoft/agent-host-protocol';
import { ensure } from '../storage/database.ts';
const ajv = new Ajv2020({ strict: false });
const require = createRequire(import.meta.url);
(require('ajv-formats') as typeof import('ajv-formats').default)(ajv);
export const pendingNativeInput = (state: ChatState) => state.activeTurn?.responseParts.some(p => p.kind === 'inputRequest' && !p.response) ?? false;
export const nativePolicyIdle = (state: ChatState) => !state.backgroundWork?.length && !state.queuedMessages?.length && (!state.activeTurn ? !(state.status & 8) : pendingNativeInput(state) && (state.status & 24) === 24);
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
function questionSchema(q: ChatInputQuestion): Record<string, unknown> {
    const description = q.message;
    switch (q.kind) {
        case 'text':
            ensure(!q.format || ['email', 'uri', 'date', 'date-time', 'hostname', 'ipv4', 'ipv6', 'uuid'].includes(q.format), 'owner_input', 'Unsupported native text format');
            return { type: 'string', description, ...(q.min === undefined ? {} : { minLength: q.min }), ...(q.max === undefined ? {} : { maxLength: q.max }), ...(q.format ? { format: q.format } : {}) };
        case 'number':
        case 'integer': return { type: q.kind, description, ...(q.min === undefined ? {} : { minimum: q.min }), ...(q.max === undefined ? {} : { maximum: q.max }) };
        case 'boolean': return { type: 'boolean', description };
        case 'single-select': {
            const choice = { type: 'string', enum: q.options.map(o => o.id) };
            return q.allowFreeformInput ? { description, oneOf: [object({ choice }, ['choice']), object({ text: { type: 'string', minLength: 1 } }, ['text'])] } : { ...choice, description };
        }
        case 'multi-select': {
            const choices = { type: 'array', items: { type: 'string', enum: q.options.map(o => o.id) }, uniqueItems: true, ...(q.min === undefined ? {} : { minItems: q.min }), ...(q.max === undefined ? {} : { maxItems: q.max }) };
            return q.allowFreeformInput ? { description, ...object({ choices, freeform: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } }, ['choices']) } : { ...choices, description };
        }
        default: throw Error('Unsupported native input question kind');
    }
}
/** Public answer values contain no caller-selected native request ID or raw AHP actions. */
export function nativeInputSchema(request: ChatInputRequest): Record<string, unknown> {
    const questions = request.questions ?? [];
    ensure(questions.every(q => typeof q.id === 'string' && q.id.length > 0) && new Set(questions.map(q => q.id)).size === questions.length, 'owner_input', 'Invalid native question identifiers');
    const answers = object(Object.fromEntries(questions.map(q => [q.id, questionSchema(q)])), questions.filter(q => q.required).map(q => q.id));
    return { oneOf: [object({ response: { const: 'accept' }, answers }, ['response', 'answers']), object({ response: { enum: ['decline', 'cancel'] } }, ['response'])] };
}
/** C4's existing queueReply places the validated public value in response (and duplicates it in answers). */
export function nativeInputReply(request: ChatInputRequest, payload: {
    response?: unknown;
    answers?: unknown;
    requestId?: string;
}): {
    response: ChatInputResponseKind;
    answers: Record<string, ChatInputAnswer>;
} {
    const envelope = payload.response && typeof payload.response === 'object' ? payload.response : { response: payload.response ?? 'accept', ...((payload.response ?? 'accept') === 'accept' ? { answers: payload.answers ?? {} } : {}) };
    ensure(ajv.compile(nativeInputSchema(request))(envelope), 'owner_input', 'Answer does not satisfy the original native question schema');
    const value = envelope as {
        response: ChatInputResponseKind;
        answers?: Record<string, unknown>;
    };
    if (value.response !== 'accept')
        return { response: value.response, answers: {} };
    const answers = Object.fromEntries((request.questions ?? []).filter(q => Object.hasOwn(value.answers!, q.id)).map(q => {
        const raw = value.answers![q.id];
        let answer: Record<string, unknown>;
        switch (q.kind) {
            case 'text':
                answer = { kind: 'text', value: raw };
                break;
            case 'number':
            case 'integer':
                answer = { kind: 'number', value: raw };
                break;
            case 'boolean':
                answer = { kind: 'boolean', value: raw };
                break;
            case 'single-select': {
                const v = raw as {
                    choice?: string;
                    text?: string;
                };
                answer = q.allowFreeformInput ? { kind: 'selected', value: v.choice ?? '', ...(v.text ? { freeformValues: [v.text] } : {}) } : { kind: 'selected', value: raw };
                break;
            }
            case 'multi-select': {
                const v = raw as {
                    choices: string[];
                    freeform?: string[];
                };
                answer = q.allowFreeformInput ? { kind: 'selected-many', value: v.choices, ...(v.freeform ? { freeformValues: v.freeform } : {}) } : { kind: 'selected-many', value: raw };
                break;
            }
            default: throw Error('Unsupported native input question');
        }
        return [q.id, { state: 'submitted', value: answer }];
    })) as unknown as Record<string, ChatInputAnswer>;
    return { response: value.response, answers };
}

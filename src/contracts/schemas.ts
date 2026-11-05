import { Type as T } from '@sinclair/typebox';
import type { Static, TProperties, TSchema } from '@sinclair/typebox';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';

const object = <P extends TProperties>(properties: P) => T.Object(properties, { additionalProperties: false });
const text = () => T.String({ minLength: 1, pattern: '\\S' });
const strings = () => T.Array(text(), { uniqueItems: true });
const timestamp = () => T.String({ format: 'date-time', pattern: 'Z$' });
const integer = (minimum = 0) => T.Integer({ minimum });
const choice = <S extends string[]>(...values: S) => T.Unsafe<S[number]>({ type: 'string', enum: values });
function withAllowedPolicy<S extends TSchema>(schema: S, field: string): S {
  return Object.assign(schema, { allOf: ['result', 'pr', 'merge_ci', 'merge_bypass'].map(policy => ({
    if: { properties: { [field]: { const: policy } } },
    then: { properties: { required: { type: 'object', properties: {
      allowedFinishPolicies: { type: 'array', contains: { const: policy } },
    } } } },
  })) });
}
const jsonObject = () => T.Record(T.String(), T.Unknown());
const optionalText = () => T.Optional(text());

const ProviderId = choice('copilot', 'codex');
const FinishPolicy = choice('result', 'pr', 'merge_ci', 'merge_bypass');
const TaskStatus = choice('queued', 'running', 'waiting_input', 'waiting_ci', 'needs_attention', 'completed', 'failed', 'cancelled');
const TaskSource = choice('manual', 'automatic', 'recipe');
const RequiredCapabilities = object({
  paths: T.Array(object({ root: text(), mode: choice('read', 'write') })),
  tools: strings(), networkDestinations: strings(), credentialRefs: strings(),
  allowedFinishPolicies: T.Array(FinishPolicy, { minItems: 1, uniqueItems: true }),
});
const ExecutionDefaults = object({ ownerId: text(), providerId: ProviderId, finishPolicy: FinishPolicy });
const FactoryConfig = object({
  schemaVersion: T.Literal(1), factoryDir: text(), taktSeconds: integer(1),
  limits: object({ concurrency: integer(1), activeMinutes: T.Number({ exclusiveMinimum: 0 }), startsPerDay: integer(1), transientRetries: integer() }),
  defaultOwnerId: text(), defaultProviderId: ProviderId,
});
const TaskSpec = withAllowedPolicy(object({
  id: text(), parentId: optionalText(), repositoryId: text(), recipeId: text(), recipeRevision: text(),
  tagId: text(), source: TaskSource, title: text(), description: text(), goal: text(),
  acceptanceCriteria: T.Array(text(), { minItems: 1 }), skills: strings(), tools: strings(), context: T.Unknown(),
  finishPolicy: FinishPolicy, ownerId: text(), providerId: ProviderId, required: RequiredCapabilities,
}), 'finishPolicy');
const CreateTaskRequest = object({
  title: text(), description: text(), recipeId: text(), repositoryIds: T.Array(text(), { minItems: 1, uniqueItems: true }),
  finishPolicy: T.Optional(FinishPolicy), ownerId: optionalText(), providerId: T.Optional(ProviderId), inputs: T.Optional(jsonObject()),
});
const TaskTemplate = object({
  title: text(), description: text(), goal: text(), acceptanceCriteria: T.Array(text(), { minItems: 1 }),
  skills: strings(), tools: strings(), context: T.Unknown(),
});
const RecipeMetadata = withAllowedPolicy(object({
  schemaVersion: T.Literal(1), recipeId: text(), displayName: text(), tagId: text(),
  inputSchema: jsonObject(), taskTemplate: TaskTemplate, required: RequiredCapabilities,
  compatibleOwners: T.Array(text(), { minItems: 1, uniqueItems: true }),
  compatibleProviders: T.Array(ProviderId, { minItems: 1, uniqueItems: true }), defaultFinishPolicy: FinishPolicy,
  defaultProviderId: T.Optional(ProviderId), skillVersions: T.Optional(T.Record(T.String(), text())), toolVersions: T.Optional(T.Record(T.String(), text())),
}), 'defaultFinishPolicy');
// Standard Kestra fields stay under Kestra's schema authority. Only variables.sf is factory metadata.
const RecipeContract = T.Object({
  id: text(), namespace: text(), description: optionalText(), inputs: T.Optional(T.Array(jsonObject())),
  variables: T.Object({ sf: RecipeMetadata }, { additionalProperties: true }),
  tasks: T.Array(jsonObject(), { minItems: 1 }), outputs: T.Optional(T.Array(jsonObject())),
}, { additionalProperties: true });
const RecipeRevision = object({
  id: text(), recipeId: text(), revision: text(), hash: text(), name: text(), description: text(),
  tagId: text(), createdAt: timestamp(), yaml: text(), contract: RecipeContract,
  inputDefaults: jsonObject(), repositoryIds: strings(), outputSchema: jsonObject(),
  skillVersions: T.Record(T.String(), text()), toolVersions: T.Record(T.String(), text()),
});
const NativeIdentity = object({ ownerId: text(), providerId: ProviderId, sessionId: text(), chatId: optionalText() });
const Usage = object({ inputTokens: T.Optional(integer()), outputTokens: T.Optional(integer()), estimated: T.Boolean() });
const NativeInput = object({ id: text(), schema: jsonObject(), prompt: text() });
const NativeSnapshot = object({ identity: NativeIdentity, state: choice('active', 'waiting', 'idle', 'lost'), inputs: T.Array(NativeInput), usage: T.Optional(Usage) });
const NativeStart = object({
  idempotencyKey: text(), attemptId: text(), task: TaskSpec, workspacePath: text(), baseSha: text(), fence: integer(1), profileId: text(),
});
const CapabilityReport = object({
  ready: T.Boolean(), reasons: T.Array(text()), supportedProviders: T.Array(ProviderId, { uniqueItems: true }),
  verifiedProfileIds: strings(), version: text(),
});
const ProviderReadiness = object({providerId:ProviderId,ready:T.Boolean(),reasons:T.Array(text()),verifiedProfileIds:strings()});
const OwnerReadiness = object({ ownerId: text(), ...CapabilityReport.properties,providers:T.Array(ProviderReadiness) });
const TaskResult = object({
  attemptId: text(), summary: text(), evidence: strings(), createdTaskIds: strings(),
  outcome: choice('result', 'changes', 'needs_input'), headSha: optionalText(),
});
// Server-owned verification receipt. It is deliberately absent from TaskResult/worker inputs.
const CloseoutResult = object({
  kind: choice('completed', 'waiting_ci', 'needs_attention'), attemptId: text(), headSha: optionalText(),
  pullRequest: T.Optional(object({ repositoryId: text(), number: integer(1), url: text(), headSha: text(), baseRef: text() })),
  mergeSha: optionalText(), reason: optionalText(),
});
const ApiError = object({ code: text(), message: text(), recovery: text(), retryable: T.Boolean() });
const TaskRecord = object({
  spec: TaskSpec, status: TaskStatus, revision: integer(1), controlMode: choice('factory', 'human'),
  createdAt: timestamp(), updatedAt: timestamp(), attemptIds: strings(), childTaskIds: strings(),
  reason: optionalText(), recovery: optionalText(), result: T.Optional(TaskResult), closeout: T.Optional(CloseoutResult), archivedAt: T.Optional(timestamp()),
});
const WorkflowIdentity = object({ executionId: text(), namespace: text(), flowId: text(), revision: text() });
const WorkflowStart = object({ idempotencyKey: text(), attemptId: text(), recipe: RecipeRevision, inputs: jsonObject(), scopeId: text(), fence: integer(1) });
const WorkflowSnapshot = object({
  identity: WorkflowIdentity, state: choice('pending', 'running', 'paused', 'completed', 'failed', 'cancelled', 'unknown'),
  inputs: T.Array(NativeInput), result: T.Optional(TaskResult), reason: optionalText(),
});
const Attempt = object({
  id: text(), taskId: text(), recipeRevision: text(), baseSha: text(), workspacePath: text(), profileId: text(),
  fence: integer(1), status: TaskStatus, native: T.Optional(NativeIdentity), workflow: T.Optional(WorkflowIdentity),
  createdAt: timestamp(), startedAt: T.Optional(timestamp()), endedAt: T.Optional(timestamp()),
  activeDurationMs: integer(), usage: T.Optional(Usage), result: T.Optional(TaskResult), closeout: T.Optional(CloseoutResult), retryOfAttemptId: optionalText(),
});
const AttentionRequest = object({
  id: text(), taskId: text(), attemptId: optionalText(), repositoryId: text(),
  source: choice('factory', 'workflow', 'owner'), kind: choice('input', 'approval', 'blocked', 'error'),
  prompt: text(), recovery: text(), inputSchema: jsonObject(), nativeInputId: optionalText(),
  status: choice('open', 'responded', 'resolved'), createdAt: timestamp(), resolvedAt: T.Optional(timestamp()), revision: integer(1),
});
const ActorScope = object({
  attemptId: text(), repositoryIds: T.Array(text(), { minItems: 1, uniqueItems: true }), recipeId: text(), recipeRevision: text(),
  grantIds: strings(), expiresAt: timestamp(), fence: integer(1),
});
const FindingInput = object({ repositoryId: text(), recipeId: text(), findingKey: text(), task: TaskSpec, relatedTaskId: optionalText() });
const Grant = object({ id: text(), recipeId: text(), recipeRevision: text(), repositoryIds: strings(),
  required: RequiredCapabilities, grantedAt: timestamp(), expiresAt: T.Optional(timestamp()), revokedAt: T.Optional(timestamp()) });
const probeFields = { scratchRepo: text(), outputDir: text(), endpoint: optionalText(), provider: T.Optional(ProviderId) };
const ProbeOptions = T.Union([
  object({ ...probeFields, mode: T.Literal('fixture'), allowLive: T.Boolean() }),
  object({ ...probeFields, mode: T.Literal('live'), allowLive: T.Literal(true) }),
]);
const ProbeEvidence = object({ name: text(), mode: choice('fixture', 'live'), status: choice('passed', 'failed', 'blocked'),
  versions: T.Record(T.String(), text()), assertions: T.Array(object({ name: text(), passed: T.Boolean() })), artifacts: strings() });
const ProfileSpec = object({
  id: text(), ownerId: text(), providerId: ProviderId, required: RequiredCapabilities,
  image: text(), workspaceRoot: text(), version: text(),
});
const VerifiedProbeEvidence = object({ ...ProbeEvidence.properties, mode: T.Literal('live'), status: T.Literal('passed'),
  versions: T.Record(T.String(), text(), { minProperties: 1 }),
  assertions: T.Array(object({ name: text(), passed: T.Literal(true) }), { minItems: 1 }),
  artifacts: T.Array(text(), { minItems: 1, uniqueItems: true }),
});
const ProfileEvidence = object({
  profileId: text(), ownerId: text(), providerId: ProviderId, verifiedAt: timestamp(),
  required: RequiredCapabilities, probes: T.Array(VerifiedProbeEvidence, { minItems: 1 }),
});
const ownerEvent = <S extends string, P extends TProperties>(type: S, properties: P) => object({ type: T.Literal(type), identity: NativeIdentity, at: timestamp(), ...properties });
const OwnerEvent = T.Union([
  ownerEvent('snapshot', { snapshot: NativeSnapshot }), ownerEvent('input', { input: NativeInput }),
  ownerEvent('activity', { active: T.Boolean() }), ownerEvent('usage', { usage: Usage }),
  ownerEvent('identity', {}), ownerEvent('connection_lost', { reason: text() }),
]);
const rpc = <S extends string, P extends TProperties>(method: S, params: P) => object({ requestId: text(), method: T.Literal(method), params: object(params) });
const OwnerRpc = T.Union([
  rpc('capabilities', { required: RequiredCapabilities }), rpc('ensureStarted', {}), rpc('ensureSession', { start: NativeStart }),
  rpc('snapshot', { identity: NativeIdentity }), rpc('send', { identity: NativeIdentity, input: jsonObject(), idempotencyKey: text() }),
  rpc('quiesce', { identity: NativeIdentity }), rpc('open', { identity: NativeIdentity }), rpc('subscribe', {}),
]);
const OwnerRpcResponse = T.Union([
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('capabilities'), result: CapabilityReport }),
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('ensureStarted'), result: T.Null() }),
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('ensureSession'), result: NativeIdentity }),
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('snapshot'), result: NativeSnapshot }),
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('send'), result: T.Null() }),
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('quiesce'), result: choice('stopped', 'waiting', 'unknown') }),
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('open'), result: object({ uri: optionalText() }) }),
  object({ requestId: text(), ok: T.Literal(true), method: T.Literal('subscribe'), result: object({ subscriptionId: text() }) }),
  object({ requestId: text(), ok: T.Literal(false), error: ApiError }),
]);
const Tag = object({ id: text(), displayName: text(), createdAt: timestamp(), archivedAt: T.Optional(timestamp()), revision: integer(1) });
const Repository = object({
  id: text(), name: text(), url: text(), active: T.Boolean(), controlMode: choice('factory', 'human'),
  revision: integer(1), createdAt: timestamp(), lastServicedAt: T.Optional(timestamp()),
  weights: T.Record(T.String(), T.Integer({ minimum: 0, maximum: 100 })),
  currentTaskId: optionalText(), reason: optionalText(), recovery: optionalText(), defaultOwnerId: optionalText(),
});
const RecipeSummary = object({ id: text(), displayName: text(), description: text(), tagId: text(), currentRevision: text(),
  revision: integer(1), active: T.Boolean(), ready: T.Boolean(), reasons: T.Array(text()) });
const AuthState = object({ status: choice('ready', 'missing', 'expired', 'denied', 'unavailable', 'identity_changed'),
  source: T.Optional(choice('gh', 'git_helper', 'github_app')), accountId: optionalText(), login: optionalText(), reasons: T.Array(text()) });
const Health = object({ schemaVersion: T.Literal(1), ready: T.Boolean(), reasons: T.Array(text()), version: text() });
const FactorySnapshot = object({
  schemaVersion: T.Literal(1), sequence: integer(), cursor: text(), at: timestamp(), config: FactoryConfig,
  paused: T.Boolean(), health: Health, auth: AuthState, tags: T.Array(Tag), repositories: T.Array(Repository),
  recipes: T.Array(RecipeSummary), tasks: T.Array(TaskRecord), attempts: T.Array(Attempt), attention: T.Array(AttentionRequest),
});
const Settings = object({ config: FactoryConfig, paused: T.Boolean(), revision: integer(1) });
const event = <S extends string, D extends TSchema>(type: S, data: D) => object({ sequence: integer(1), cursor: text(), at: timestamp(), type: T.Literal(type), data });
const FactoryEvent = T.Union([
  event('task', TaskRecord), event('attempt', Attempt), event('attention', AttentionRequest),
  event('repository', Repository), event('tag', Tag), event('recipe', RecipeSummary),
  event('settings', Settings), event('health', Health), event('auth', AuthState),
  event('snapshot_required', object({ reason: text() })),
]);
const Artifact = object({ id: text(), attemptId: text(), name: text(), mediaType: text(), sizeBytes: integer(), createdAt: timestamp() });
const worker = <S extends string, P extends TSchema>(operation: S, payload: P) => object({ requestId: text(), idempotencyKey: text(), scope: ActorScope,
  operation: T.Literal(operation), payload });
const WorkerRequest = T.Union([
  worker('task.create', TaskSpec),
  worker('task.read', object({ taskId: text() })),
  worker('task.update', object({ taskId: text(), revision: integer(1), title: optionalText(), description: optionalText(),
    goal: optionalText(), acceptanceCriteria: T.Optional(T.Array(text(), { minItems: 1 })) })),
  worker('task.cancel', object({ taskId: text(), revision: integer(1) })),
  worker('finding.upsert', FindingInput), worker('native.start', NativeStart),
  worker('native.continue', object({ identity: NativeIdentity, input: jsonObject() })), worker('result.submit', TaskResult),
  worker('artifact.register', Artifact), worker('artifact.read', object({ artifactId: text() })),
  worker('attention.create', AttentionRequest),
]);
const WorkerResponse = T.Union([
  object({ requestId: text(), ok: T.Literal(true), result: T.Union([TaskRecord, NativeIdentity, TaskResult, Artifact, AttentionRequest, T.Null()]) }),
  object({ requestId: text(), ok: T.Literal(false), error: ApiError }),
]);

// The engine sees only this opaque envelope; logical worker contracts and authorization are unchanged.
const WorkerTransport = object({ encoding: T.Literal('sf-base64url-json-v1'), payload: T.String({ minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }) });

const SettingsPatch = object({
  taktSeconds: T.Optional(integer(1)), limits: T.Optional(FactoryConfig.properties.limits),
  defaultOwnerId: optionalText(), defaultProviderId: T.Optional(ProviderId), paused: T.Optional(T.Boolean()),
});
const RepositoryPatch = object({ active: T.Optional(T.Boolean()), defaultOwnerId: T.Optional(T.Union([text(), T.Null()])) });
const WeightsPatch = object({ weights: T.Record(T.String(), T.Integer({ minimum: 0, maximum: 100 })) });
const RotationPreview = object({ repositoryId: text(), tagIds: strings(), nextTagIds: T.Array(text()), reason: optionalText() });
const TagCreate = object({ displayName: text() });
const TagPatch = object({ displayName: optionalText(), reassignToTagId: optionalText() });
const TagArchive = object({ reassignToTagId: text() });
const TaskPatch = object({ title: optionalText(), description: optionalText(), goal: optionalText(),
  acceptanceCriteria: T.Optional(T.Array(text(), { minItems: 1 })), finishPolicy: T.Optional(FinishPolicy),
  ownerId: optionalText(), providerId: T.Optional(ProviderId), status: T.Optional(T.Literal('cancelled')) });
const RecipeCreate = object({ yaml: text(), inputDefaults: T.Optional(jsonObject()), repositoryIds: T.Optional(strings()) });
const RecipeValidation = object({ valid: T.Boolean(), errors: T.Array(text()), contract: T.Optional(RecipeContract),
  hash: optionalText(), payloadHash: optionalText(), issues: T.Optional(T.Array(object({ field: T.String(), message: text(), line: integer(1), column: integer(1) }))),
  readiness: T.Optional(object({ ready: T.Boolean(), reasons: T.Array(text()), requested: RequiredCapabilities, approved: T.Boolean() })),
});
const RecipePatch = object({ active: T.Optional(T.Boolean()), displayName: optionalText(), approval: T.Optional(object({
  recipeHash: text(), payloadHash: text(), repositoryIds: strings(), capabilities: RequiredCapabilities,
})) });
const DispatchResult = object({ admitted: T.Boolean(), taskId: optionalText(), attemptId: optionalText(), reason: optionalText() });
const AttentionResponse = object({ input: jsonObject() });
const NativeOpenResult = object({ uri: optionalText() });
const DeviceFlow = object({ id: text(), userCode: text(), verificationUri: T.String({ format: 'uri' }),
  expiresAt: timestamp(), pollIntervalMs: integer(1), status: choice('pending', 'authorized', 'expired', 'denied') });
const Empty = object({});
const Acknowledgement = object({ accepted: T.Boolean() });

export const schemas = {
  ProviderId, FinishPolicy, TaskStatus, TaskSource, RequiredCapabilities, ExecutionDefaults, FactoryConfig,
  TaskSpec, CreateTaskRequest, TaskTemplate, RecipeMetadata, RecipeContract, RecipeRevision,
  NativeIdentity, Usage, NativeInput, NativeSnapshot, NativeStart, CapabilityReport, ProviderReadiness, OwnerReadiness, TaskResult, CloseoutResult, ApiError,
  TaskRecord, WorkflowIdentity, WorkflowStart, WorkflowSnapshot, Attempt, AttentionRequest, ActorScope,
  FindingInput, Grant, ProbeOptions, ProbeEvidence, VerifiedProbeEvidence, ProfileSpec, ProfileEvidence, OwnerEvent, OwnerRpc, OwnerRpcResponse,
  Tag, Repository, RecipeSummary, AuthState, Health, FactorySnapshot, FactoryEvent, Artifact, WorkerRequest, WorkerResponse, WorkerTransport,
  SettingsPatch, Settings, RepositoryPatch, WeightsPatch, RotationPreview, TagCreate, TagPatch, TagArchive,
  TaskPatch, RecipeCreate, RecipeValidation, RecipePatch, DispatchResult, AttentionResponse, NativeOpenResult,
  DeviceFlow, Empty, Acknowledgement,
} as const;
export type ContractName = keyof typeof schemas;
export type Contract<N extends ContractName> = Static<(typeof schemas)[N]>;

// ajv-formats is CommonJS; keep its callable export typed without a default-import interop assumption.
const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as typeof import('ajv-formats').default;
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
addFormats(ajv);
const validators = new Map<ContractName, ReturnType<typeof ajv.compile>>();

export function validateContract<N extends ContractName>(name: N, value: unknown): Contract<N> {
  let validate = validators.get(name);
  if (!validate) { validate = ajv.compile(schemas[name]); validators.set(name, validate); }
  if (!validate(value)) throw new TypeError(`Invalid ${name}: ${ajv.errorsText(validate.errors, { dataVar: name })}`);
  return value as Contract<N>;
}
export function validateTask(value: unknown): Contract<'TaskSpec'> {
  return validateContract('TaskSpec', value);
}
export function validateRecipeContract(value: unknown): Contract<'RecipeContract'> {
  return validateContract('RecipeContract', value);
}

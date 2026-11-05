import { createHash } from 'node:crypto';
import { parseDocument, isAlias, isMap, isScalar, isSeq, LineCounter } from 'yaml';
import type { Node } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Grant, RecipeContract, RecipeValidation } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { canonical } from '../storage/database.ts';
import { RecipePolicyError, PUBLIC_BROKER_AUTHORIZATION, isBrokerFlow, requirePolicy, templateReferences, validateEnginePolicy, validateInputSchema } from './policy.ts';

export interface ValidatedRecipe {
  yaml: string; hash: string; contract: RecipeContract;
  skillVersions: Record<string, string>; toolVersions: Record<string, string>;
  /** Grants are candidates only; registry rechecks exact immutable revision, scope and time. */
  grants: Grant[];
}
export class RecipeValidationError extends Error {
  readonly issues: NonNullable<RecipeValidation['issues']>;
  constructor(issues: NonNullable<RecipeValidation['issues']>) { super(issues.map(issue => `${issue.field || '/'}:${issue.line}:${issue.column} ${issue.message}`).join('; ')); this.name = 'RecipeValidationError'; this.issues = issues; }
}
function inspectNode(node: Node | null | undefined, depth = 0): void {
  if (!node) return;
  requirePolicy(depth <= 48, '', 'YAML nesting exceeds 48');
  requirePolicy(!isAlias(node), '', 'YAML aliases are forbidden');
  requirePolicy(!node.tag && !node.anchor, '', 'YAML tags and anchors are forbidden');
  if (isMap(node)) for (const pair of node.items) {
    requirePolicy(isScalar(pair.key) && typeof pair.key.value === 'string' && !['__proto__', 'constructor', 'prototype', '<<'].includes(pair.key.value), '', 'YAML keys must be safe strings');
    inspectNode(pair.key, depth + 1);
    inspectNode(pair.value as Node, depth + 1);
  }
  if (isSeq(node)) for (const item of node.items) inspectNode(item as Node, depth + 1);
  if (isScalar(node) && typeof node.value === 'number') requirePolicy(Number.isFinite(node.value), '', 'Non-finite YAML numbers are forbidden');
}
export function inputValues(schema: Record<string, unknown>, defaults: Record<string, unknown>, supplied: Record<string, unknown> = {}): Record<string, unknown> {
  validateInputSchema(schema);
  const value = structuredClone({ ...defaults, ...supplied });
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true, ownProperties: true });
  const check = ajv.compile(schema);
  requirePolicy(check(value), '/inputDefaults', `Inputs do not match the declared schema: ${ajv.errorsText(check.errors)}`);
  return value;
}
export function validateRecipe(yaml: string, grants: Grant[]): ValidatedRecipe {
  const lines = new LineCounter();
  let document: ReturnType<typeof parseDocument> | undefined;
  try {
    requirePolicy(typeof yaml === 'string' && Buffer.byteLength(yaml, 'utf8') <= 512 * 1024, '', 'Imported YAML exceeds 512 KiB');
    document = parseDocument(yaml, { lineCounter: lines, uniqueKeys: true, version: '1.2', strict: true });
    if (document.errors.length || document.warnings.length) {
      const issue = document.errors[0] ?? document.warnings[0]!;
      const pos = lines.linePos(issue.pos[0]); throw new RecipeValidationError([{ field: '', message: issue.message, line: pos.line, column: pos.col }]);
    }
    inspectNode(document.contents as Node);
    const contract = validateContract('RecipeContract', document.toJS({ maxAliasCount: 0 }));
    validateEnginePolicy(contract);
    if (isBrokerFlow(contract)) {
      for (const [index, literal] of [[0, PUBLIC_BROKER_AUTHORIZATION[0]!], [2, PUBLIC_BROKER_AUTHORIZATION[1]!]] as const) {
        const node = document.getIn(['tasks', index, 'headers', 'Authorization'], true) as Node;
        const raw = yaml.slice(node.range![0], node.range![1]).trim();
        requirePolicy([literal, `"${literal}"`, `'${literal}'`].includes(raw), `/tasks/${index}/headers/Authorization`, 'Reserved Authorization scalar must use canonical plain or quoted spelling');
      }
    }
    const metadata = contract.variables.sf;
    validateInputSchema(metadata.inputSchema);
    requirePolicy(metadata.inputSchema.type === 'object', '/variables/sf/inputSchema', 'Recipe inputs require an object schema');
    // Compile without applying defaults, to reject invalid local schemas before persistence.
    new Ajv2020({ strict: true, ownProperties: true }).compile(metadata.inputSchema);
    templateReferences(metadata.taskTemplate, new Set(Object.keys(metadata.inputSchema.properties as object)));
    requirePolicy(!metadata.defaultProviderId || metadata.compatibleProviders.includes(metadata.defaultProviderId), '/variables/sf/defaultProviderId', 'Default provider must be compatible');
    const skillVersions = metadata.skillVersions ?? {}; const toolVersions = metadata.toolVersions ?? {};
    for (const [kind, refs, versions] of [['skills', metadata.taskTemplate.skills, skillVersions], ['tools', metadata.taskTemplate.tools, toolVersions]] as const) {
      requirePolicy(refs.every(id => typeof versions[id] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(versions[id]!)) && Object.keys(versions).every(id => refs.includes(id)), `/variables/sf/${kind}`, 'Each declared reference requires an exact version, without undeclared versions');
    }
    requirePolicy(canonical([...metadata.taskTemplate.tools].sort()) === canonical([...metadata.required.tools].sort()), '/variables/sf/required/tools', 'Task tools must exactly match declared tool capabilities');
    return { yaml, hash: `sha256:${createHash('sha256').update(yaml, 'utf8').digest('hex')}`, contract, skillVersions, toolVersions, grants: grants.map(grant => structuredClone(validateContract('Grant', grant))) };
  } catch (error) {
    if (error instanceof RecipeValidationError) throw error;
    const field = error instanceof RecipePolicyError ? error.field : error instanceof TypeError ? (error.message.match(/RecipeContract(\/[^ ]*)/)?.[1] ?? '') : '';
    let offset = 0;
    if (document && field) {
      const node = document.getIn(field.split('/').filter(Boolean).map(part => /^\d+$/.test(part) ? Number(part) : part), true) as Node | undefined;
      offset = node?.range?.[0] ?? 0;
    }
    const pos = lines.linePos(offset);
    throw new RecipeValidationError([{ field, message: error instanceof Error ? error.message : 'Invalid recipe', line: pos.line, column: pos.col }]);
  }
}

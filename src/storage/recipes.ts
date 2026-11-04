import { randomUUID } from 'node:crypto';
import type { RecipePatch, RecipeRevision, RecipeSummary, Tag } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreDatabase, canonical, ensure, fingerprint } from './database.ts';

export class RecipeStorage {
  private db: StoreDatabase;
  constructor(db: StoreDatabase) { this.db = db; }
  summary(id: string): RecipeSummary | undefined { return this.db.read('recipes', id); }
  revision(id: string, revision: string): RecipeRevision | undefined {
    const row = this.db.sql.prepare('SELECT payload FROM recipe_revisions WHERE recipe_id = ? AND revision = ?').get(id, revision);
    return row ? JSON.parse(String(row.payload)) as RecipeRevision : undefined;
  }
  current(id: string): RecipeRevision | undefined {
    const recipe = this.summary(id);
    return recipe ? this.revision(id, recipe.currentRevision) : undefined;
  }
  save(input: RecipeRevision, expectedRevision?: number): RecipeSummary {
    const value = structuredClone(validateContract('RecipeRevision', input));
    const metadata = value.contract.variables.sf;
    ensure(value.recipeId === metadata.recipeId && value.tagId === metadata.tagId, 'invalid_recipe', 'Recipe metadata must match its recipe ID and tag');
    const tag = this.db.read<Tag>('tags', value.tagId);
    ensure(tag && !tag.archivedAt, 'invalid_tag', 'Recipe tag must be active');
    for (const id of value.repositoryIds) ensure(this.db.read('repositories', id), 'invalid_repository', 'Recipe repository does not exist');
    const existing = this.summary(value.recipeId);
    ensure(existing ? expectedRevision === existing.revision : expectedRevision === undefined, 'revision_conflict', 'Recipe revision conflict');
    ensure(!this.revision(value.recipeId, value.revision), 'immutable_revision', 'Recipe revisions are immutable; use a new revision ID');
    const summary = validateContract('RecipeSummary', {
      id: value.recipeId, displayName: value.name, description: value.description, tagId: value.tagId,
      currentRevision: value.revision, revision: (existing?.revision ?? 0) + 1,
      active: existing?.active ?? true, ready: false, reasons: ['Recipe capability readiness has not been verified for this revision'],
    });
    this.db.sql.prepare('INSERT INTO recipes(id, tag_id, current_revision, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tag_id = excluded.tag_id, current_revision = excluded.current_revision, payload = excluded.payload').run(summary.id, summary.tagId, summary.currentRevision, JSON.stringify(summary));
    this.db.sql.prepare('INSERT INTO recipe_revisions(id, recipe_id, revision, tag_id, payload) VALUES (?, ?, ?, ?, ?)').run(value.id, value.recipeId, value.revision, value.tagId, JSON.stringify(value));
    this.db.emit('recipe', summary);
    return summary;
  }
  patch(id: string, patch: RecipePatch, expectedRevision: number): RecipeSummary {
    validateContract('RecipePatch', patch);
    const old = this.summary(id);
    ensure(old, 'not_found', 'Recipe not found');
    ensure(old.revision === expectedRevision, 'revision_conflict', 'Recipe revision conflict');
    const value = validateContract('RecipeSummary', { ...old, ...patch, revision: old.revision + 1 });
    const tag = this.db.read<Tag>('tags', old.tagId);
    ensure(!value.active || (tag && !tag.archivedAt), 'archived_tag', 'Cannot activate a recipe with an archived tag');
    this.db.sql.prepare('UPDATE recipes SET payload = ? WHERE id = ?').run(JSON.stringify(value), id);
    this.db.emit('recipe', value);
    return value;
  }
  reassignActiveTag(id: string, replacementId: string): Map<string, RecipeRevision> {
    const replacements = new Map<string, RecipeRevision>();
    for (const recipe of this.db.all<RecipeSummary>('recipes')) {
      if (recipe.tagId !== id || !recipe.active) continue;
      const old = this.current(recipe.id)!;
      const revision = this.withTag(old, replacementId);
      this.save(revision, recipe.revision);
      replacements.set(`${old.recipeId}:${old.revision}`, revision);
    }
    return replacements;
  }
  /** Retag a pinned queued revision without changing the recipe's current template. */
  retagPinned(recipeId: string, revision: string, tagId: string): RecipeRevision {
    const old = this.revision(recipeId, revision)!;
    const value = this.withTag(old, tagId);
    this.db.sql.prepare('INSERT INTO recipe_revisions(id, recipe_id, revision, tag_id, payload) VALUES (?, ?, ?, ?, ?)').run(value.id, value.recipeId, value.revision, value.tagId, JSON.stringify(value));
    return value;
  }
  private withTag(old: RecipeRevision, tagId: string): RecipeRevision {
    const contract = structuredClone(old.contract);
    contract.variables.sf.tagId = tagId;
    const yaml = canonical(contract); // JSON is YAML 1.2; E1 may later format this validated contract.
    const hash = `sha256:${fingerprint(contract)}`;
    return validateContract('RecipeRevision', { ...old, id: randomUUID(), revision: randomUUID(), tagId, contract, yaml, hash, createdAt: this.db.now() });
  }
}

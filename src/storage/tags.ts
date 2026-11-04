import { randomUUID } from 'node:crypto';
import type { Tag, TagCreate, TagPatch, Repository, TaskRecord } from '../contracts/domain.ts';
import { validateContract } from '../contracts/schemas.ts';
import { StoreDatabase, ensure } from './database.ts';
import type { RecipeStorage } from './recipes.ts';

const defaultTagNames = ['Performance', 'Bug Fixes', 'Features', 'Wiz Fixes', 'SonarQube Fixes', 'Research', 'Improve Codebase Quality'];
export class TagStorage {
  private db: StoreDatabase;
  constructor(db: StoreDatabase) { this.db = db; }
  seed(): void { for (const displayName of defaultTagNames) this.create({ displayName }); }
  create(input: TagCreate): Tag {
    validateContract('TagCreate', input);
    const tag = validateContract('Tag', { id: randomUUID(), displayName: input.displayName, createdAt: this.db.now(), revision: 1 });
    this.db.sql.prepare('INSERT INTO tags(id, payload) VALUES (?, ?)').run(tag.id, JSON.stringify(tag));
    this.db.emit('tag', tag);
    return tag;
  }
  patch(id: string, input: TagPatch, expectedRevision: number): Tag {
    validateContract('TagPatch', input);
    ensure(input.reassignToTagId === undefined, 'invalid_patch', 'Use archiveTag to reassign referenced work');
    const tag = this.require(id);
    ensure(tag.revision === expectedRevision, 'revision_conflict', 'Tag revision conflict');
    return this.write({ ...tag, ...(input.displayName ? { displayName: input.displayName } : {}), revision: tag.revision + 1 });
  }
  require(id: string): Tag {
    const tag = this.db.read<Tag>('tags', id);
    ensure(tag, 'not_found', 'Tag not found'); return tag;
  }
  write(tag: Tag): Tag {
    validateContract('Tag', tag);
    this.db.sql.prepare('UPDATE tags SET payload = ? WHERE id = ?').run(JSON.stringify(tag), tag.id);
    this.db.emit('tag', tag); return tag;
  }
  delete(id: string, expectedRevision: number): void {
    const tag = this.require(id);
    ensure(tag.revision === expectedRevision, 'revision_conflict', 'Tag revision conflict');
    const references = this.db.sql.prepare(`SELECT 1 FROM recipe_revisions WHERE tag_id = ? UNION ALL SELECT 1 FROM tasks WHERE tag_id = ? UNION ALL SELECT 1 FROM repository_weights WHERE tag_id = ? LIMIT 1`).get(id, id, id);
    ensure(!references, 'tag_in_use', 'Referenced tags must be archived with a replacement');
    this.db.sql.prepare('DELETE FROM tags WHERE id = ?').run(id);
    // The wire event union has no delete envelope. Force consumers to refresh the snapshot.
    this.db.emit('snapshot_required', { reason: 'Tag deleted' });
  }
  archive(id: string, replacementId: string, recipes: RecipeStorage, updateTask: (value: TaskRecord) => void, expectedRevision?: number): void {
    const tag = this.require(id);
    ensure(expectedRevision === undefined || tag.revision === expectedRevision, 'revision_conflict', 'Tag revision conflict');
    const replacement = this.require(replacementId);
    ensure(id !== replacementId && !replacement.archivedAt, 'invalid_replacement', 'An active different replacement tag is required');
    if (tag.archivedAt) return;
    const revisions = recipes.reassignActiveTag(id, replacementId);
    for (const task of this.db.all<TaskRecord>('tasks')) {
      if (task.spec.tagId !== id || task.status !== 'queued') continue;
      // A queued reservation may already have launched. Its immutable pin is part of external identity.
      if (this.db.sql.prepare('SELECT id FROM admission_reservations WHERE task_id = ? AND lease_active = 1').get(task.spec.id)) continue;
      const key = `${task.spec.recipeId}:${task.spec.recipeRevision}`;
      let revision = revisions.get(key);
      if (!revision) {
        revision = recipes.retagPinned(task.spec.recipeId, task.spec.recipeRevision, replacementId);
        revisions.set(key, revision);
      }
      updateTask({ ...task, spec: { ...task.spec, tagId: replacementId, recipeRevision: revision.revision }, updatedAt: this.db.now(), revision: task.revision + 1 });
    }
    for (const repo of this.db.all<Repository>('repositories')) {
      if (!Object.hasOwn(repo.weights, id)) continue;
      const weights = { ...repo.weights };
      if (!Object.hasOwn(weights, replacementId)) weights[replacementId] = weights[id]!;
      delete weights[id];
      const updated = { ...repo, weights, revision: repo.revision + 1 };
      this.db.sql.prepare('DELETE FROM repository_weights WHERE repository_id = ? AND tag_id = ?').run(repo.id, id);
      this.db.sql.prepare('INSERT INTO repository_weights(repository_id, tag_id, value) VALUES (?, ?, ?) ON CONFLICT(repository_id, tag_id) DO NOTHING').run(repo.id, replacementId, weights[replacementId]!);
      this.db.sql.prepare('UPDATE repositories SET payload = ? WHERE id = ?').run(JSON.stringify(updated), repo.id);
      this.db.emit('repository', updated);
    }
    this.write({ ...tag, archivedAt: this.db.now(), revision: tag.revision + 1 });
  }
}

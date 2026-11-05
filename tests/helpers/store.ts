import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.ts';
import type { OpenStoreOptions } from '../../src/storage/store.ts';
import { FakeClock } from './clock.ts';
import { grantFixture, materializeFixture, recipeFixture, scopeFixture } from './fixtures.ts';

export function createFixture(options: OpenStoreOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sf-store-'));
  const path = join(directory, 'factory.sqlite');
  const clock = new FakeClock();
  const dependencies = { clock, materialize: materializeFixture, ...options };
  let store = openStore(path, dependencies);
  const tag = store.snapshot().tags.find(tag => tag.displayName === 'Features')!;
  store.createRepository({ id: 'repo-1', name: 'One', url: 'https://example.test/one.git' });
  store.createRepository({ id: 'repo-2', name: 'Two', url: 'https://example.test/two.git' });
  const recipe = recipeFixture(tag.id);
  store.saveRecipeRevision(recipe);
  const request = { recipeId: recipe.recipeId, title: 'Seed', description: 'Seed task', repositoryIds: ['repo-1'] };
  const [task] = store.createManualTasks(request, 'seed');
  const actor = scopeFixture();
  store.saveGrant(grantFixture(recipe));
  store.registerActor(actor, task!.id);
  return { get store() { return store; }, clock, path, directory, recipe, task: task!, actor, request,
    reopen() { store.close(); store = openStore(path, dependencies); return store; },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

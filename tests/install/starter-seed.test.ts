import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../../src/storage/store.ts';
import {recipeMaterializer} from '../../src/recipes/materialize.ts';
import {seedStarters} from '../../src/install/starter-seed.ts';

test('starters use actual editable tag IDs and require ordinary repository approval',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-starters-'));const store=openStore(join(root,'factory.sqlite'),{materialize:recipeMaterializer});
 try {
  seedStarters(store);const snapshot=store.snapshot();assert.equal(snapshot.recipes.length,3);assert.equal(store.getAdmissionState().grants.length,0);
  for(const [id,name] of [['focused-feature','Features'],['focused-bug-fix','Bug Fixes'],['scoped-quality','Improve Codebase Quality']] as const){const recipe=store.getRecipe(id)!;const tag=snapshot.tags.find(t=>t.displayName===name)!;assert.equal(recipe.tagId,tag.id);assert.notEqual(recipe.tagId,name);assert.equal(recipe.toolVersions['native-files'],'2');assert.equal(snapshot.recipes.find(r=>r.id===id)?.active,false)}
  seedStarters(store);assert.equal(store.snapshot().recipes.length,3);
 } finally {store.close();rmSync(root,{recursive:true});}
});

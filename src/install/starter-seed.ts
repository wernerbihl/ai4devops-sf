import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import type { FactoryStore } from '../storage/store.ts';
import { RecipeRegistry } from '../recipes/registry.ts';
import { resolveNativeToolReference } from '../owners/toolkits.ts';

/** Seed editable v2 starter revisions without granting capabilities or activating repositories. */
export function seedStarters(store:FactoryStore):void {
  const entries=[['focused-feature','Features'],['focused-bug-fix','Bug Fixes'],['scoped-quality','Improve Codebase Quality']] as const;
  const registry=new RecipeRegistry(store,{resolveReference:resolveNativeToolReference});
  for(const [id,name] of entries){
    if(store.getRecipe(id))continue;
    const matches=store.snapshot().tags.filter(tag=>tag.displayName===name&&!tag.archivedAt);
    if(matches.length!==1)throw new Error(`Default tag ${name} is missing or ambiguous`);
    const url=new URL(import.meta.url.endsWith('.ts')?`../../recipes/starter/${id}.yaml`:`../recipes/starter/${id}.yaml`,import.meta.url);
    const doc=parseDocument(readFileSync(url,'utf8'));if(doc.errors.length)throw new Error('Bundled starter recipe is invalid');
    doc.setIn(['variables','sf','tagId'],matches[0]!.id);
    const input={yaml:doc.toString(),repositoryIds:[],inputDefaults:{}};
    const validation=registry.validate(input);
    if(!validation.valid||!validation.hash||!validation.payloadHash||!validation.executionProfileHash)throw new Error('Bundled starter validation failed');
    registry.createCommand({...input,validation:{recipeHash:validation.hash,payloadHash:validation.payloadHash,executionProfileHash:validation.executionProfileHash}},{key:`starter:${id}`});
  }
}

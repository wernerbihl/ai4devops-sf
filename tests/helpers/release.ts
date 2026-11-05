import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {produceReleaseProvenance} from '../../scripts/release-provenance.ts';
/** A real committed owned fixture release, never a production provenance bypass. */
export function commitFixtureRelease(root:string):void {
 mkdirSync(join(root,'src'),{recursive:true});mkdirSync(join(root,'release'),{recursive:true});
 writeFileSync(join(root,'src/fixture.ts'),'// Nonsecret service/controller boundary fixture.\n');
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 git('init','-q');git('add','src','bin','package.json','package-lock.json');git('-c','user.name=Owned release fixture','-c','user.email=fixture@example.test','commit','-qm','owned fixture source');
 produceReleaseProvenance(root);
}

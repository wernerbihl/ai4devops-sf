import test from 'node:test';import assert from 'node:assert/strict';import {inspectProtectedMounts} from '../../src/kestra/mount-survey.ts';
test('only the verified engine may bind protected state, including parent-directory mounts',async()=>{
 const engine='a'.repeat(64),other='b'.repeat(64);const objects:any={[engine]:{Id:engine,Mounts:[{Type:'bind',Source:'/factory/kestra/data',Destination:'/app/data',RW:true}]},[other]:{Id:other,Mounts:[{Type:'bind',Source:'/other',Destination:'/work',RW:true}]}};
 const docker={async command(args:string[]){if(args[1]==='ls')return engine+'\n'+other;if(args[1]==='inspect')return JSON.stringify([objects[args[2]!]]);throw Error('unexpected')}};
 assert.deepEqual(await inspectProtectedMounts('/factory',engine,docker),[]);objects[other].Mounts[0].Source='/factory';assert.deepEqual(await inspectProtectedMounts('/factory',engine,docker),[other]);
});

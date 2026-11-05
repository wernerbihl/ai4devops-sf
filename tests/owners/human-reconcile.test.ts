import {test} from 'node:test';
import assert from 'node:assert/strict';
import {humanActionObserved} from '../../src/owners/human-reconcile.ts';
import {fingerprint} from '../../src/storage/database.ts';
test('lost turn acknowledgement reconciles only exact original turn and message',()=>{
 const message={text:'fixture',origin:{kind:'user'}};const proof={type:'chat/turnStarted',turnId:'turn-1',messageHash:fingerprint(message)};
 assert.equal(humanActionObserved(proof,{turns:[{id:'turn-1',message}]}),true);
 assert.equal(humanActionObserved(proof,{turns:[{id:'turn-1',message:{text:'different'}}]}),false);
 assert.equal(humanActionObserved(proof,{turns:[{id:'other',message}]}),false);
 assert.equal(humanActionObserved({type:'chat/inputCompleted'},{turns:[]}),false);
});

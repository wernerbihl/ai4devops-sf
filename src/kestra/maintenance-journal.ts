import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertWindowsPrivateDirectoryAsync, assertWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { ensure } from '../storage/database.ts';
import { canonical, fingerprint } from '../storage/database.ts';
import { validateContract } from '../contracts/schemas.ts';
import type { WorkflowIdentity } from '../contracts/domain.ts';
import type { ExecutionIntent } from './executions.ts';

/** Inspect existing execution intents without initializing, repairing or replaying the journal. */
async function openExistingJournal(directory:string):Promise<DatabaseSync> {
  ensure(resolve(directory)===directory&&realpathSync(directory)===directory,'engine_journal','Canonical existing engine journal directory required');
  const dir=lstatSync(directory);ensure(dir.isDirectory()&&!dir.isSymbolicLink(),'engine_journal','Engine journal directory is unsafe');
  if(process.platform==='win32')await assertWindowsPrivateDirectoryAsync(directory);else ensure(dir.uid===process.getuid!()&&(dir.mode&0o077)===0,'engine_journal','Private engine journal directory required');
  const path=join(directory,'execution-intents.sqlite');const file=lstatSync(path);
  ensure(file.isFile()&&!file.isSymbolicLink()&&realpathSync(path)===path,'engine_journal','Existing engine journal required');
  if(process.platform==='win32')await assertWindowsPrivateFileAsync(path);else ensure(file.uid===process.getuid!()&&(file.mode&0o077)===0,'engine_journal','Private engine journal required');
  for(const suffix of ['-journal','-wal','-shm']){try{lstatSync(path+suffix);throw new Error('Engine journal has an unresolved transaction')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
  return new DatabaseSync(path,{readOnly:true});
}
export async function inspectExecutionIntents(directory:string):Promise<{blocked:{attemptId:string;reason:string}[]}> {
  const db=await openExistingJournal(directory);
  try {
    const rows=db.prepare('SELECT attempt, body FROM intents ORDER BY attempt').all();const blocked:{attemptId:string;reason:string}[]=[];
    for(const row of rows){
      const attemptId=String(row.attempt);const value=JSON.parse(String(row.body));
      ensure(attemptId.length>0&&value&&typeof value==='object'&&value.start?.attemptId===attemptId&&['prepared','sent','known'].includes(value.phase)&&(!value.resume||['pending','sent','done'].includes(value.resume.phase)),'engine_journal','Invalid engine intent retains recovery');
      let knownIdentity=false;
      if(value.phase==='known'&&value.identity)try{validateContract('WorkflowIdentity',value.identity);knownIdentity=/^[A-Za-z0-9_-]+$/.test(value.identity.executionId)}catch{/* Invalid identities remain blocked. */}
      if(!knownIdentity||value.resume&&value.resume.phase!=='done'||value.stopRequested===true)blocked.push({attemptId,reason:'Original engine action is pending or unknown'});
    }
    return {blocked};
  } finally {db.close()}
}
/** Read only the exact original intent; never create, rebind, or replay it. */
export async function readExecutionIntent(directory:string,identity:WorkflowIdentity):Promise<ExecutionIntent> {
  validateContract('WorkflowIdentity',identity);ensure(/^[A-Za-z0-9_-]+$/.test(identity.executionId),'engine_journal','Unsafe execution identity');
  const db=await openExistingJournal(directory);
  try {
    const rows=db.prepare("SELECT body FROM intents WHERE json_extract(body, '$.identity.executionId')=?").all(identity.executionId);
    ensure(rows.length===1,'engine_journal','Original execution intent is unavailable');const value=JSON.parse(String(rows[0]!.body)) as ExecutionIntent;
    validateContract('WorkflowStart',value.start);
    ensure(value.phase==='known'&&canonical(value.identity)===canonical(identity)&&value.hash===fingerprint(value.start)&&typeof value.namespace==='string'&&typeof value.flowId==='string'&&Number.isSafeInteger(value.engineRevision)&&value.engineRevision>0&&(!value.resume||['pending','sent','done'].includes(value.resume.phase)),'engine_journal','Original execution intent is invalid or unresolved');
    return value;
  } finally {db.close()}
}

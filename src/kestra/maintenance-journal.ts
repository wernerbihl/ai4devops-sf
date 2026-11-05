import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertWindowsPrivateDirectoryAsync, assertWindowsPrivateFileAsync } from '../platform/windows-private.ts';
import { ensure } from '../storage/database.ts';

/** Inspect existing execution intents without initializing, repairing or replaying the journal. */
export async function inspectExecutionIntents(directory:string):Promise<{blocked:{attemptId:string;reason:string}[]}> {
  ensure(resolve(directory)===directory&&realpathSync(directory)===directory,'engine_journal','Canonical existing engine journal directory required');
  const dir=lstatSync(directory);ensure(dir.isDirectory()&&!dir.isSymbolicLink(),'engine_journal','Engine journal directory is unsafe');
  if(process.platform==='win32')await assertWindowsPrivateDirectoryAsync(directory);else ensure(dir.uid===process.getuid!()&&(dir.mode&0o077)===0,'engine_journal','Private engine journal directory required');
  const path=join(directory,'execution-intents.sqlite');const file=lstatSync(path);
  ensure(file.isFile()&&!file.isSymbolicLink()&&realpathSync(path)===path,'engine_journal','Existing engine journal required');
  if(process.platform==='win32')await assertWindowsPrivateFileAsync(path);else ensure(file.uid===process.getuid!()&&(file.mode&0o077)===0,'engine_journal','Private engine journal required');
  for(const suffix of ['-journal','-wal','-shm']){try{lstatSync(path+suffix);throw new Error('Engine journal has an unresolved transaction')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const rows=db.prepare('SELECT attempt, body FROM intents ORDER BY attempt').all();const blocked:{attemptId:string;reason:string}[]=[];
    for(const row of rows){
      const attemptId=String(row.attempt);const value=JSON.parse(String(row.body));
      ensure(attemptId.length>0&&value&&typeof value==='object'&&value.start?.attemptId===attemptId&&['prepared','sent','known'].includes(value.phase)&&(!value.resume||['pending','sent','done'].includes(value.resume.phase)),'engine_journal','Invalid engine intent retains recovery');
      if(value.phase!=='known'||!value.identity||value.resume&&value.resume.phase!=='done'||value.stopRequested===true)blocked.push({attemptId,reason:'Original engine action is pending or unknown'});
    }
    return {blocked};
  } finally {db.close()}
}

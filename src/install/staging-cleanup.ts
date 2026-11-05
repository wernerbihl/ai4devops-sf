import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPrivateFile } from '../service/config.ts';
/** Remove only owned staged bearer/token files; an unproved GUI profile is retained. */
export function clearStagedCredential(root:string):void {
 if(process.platform==='win32')throw new Error('Windows protected staging cleanup is unavailable');const directory=lstatSync(root);
 if(resolve(root)!==root||realpathSync(root)!==root||!directory.isDirectory()||directory.uid!==process.getuid!()||(directory.mode&0o077)!==0)throw new Error('Unsafe staging directory');
 for(const path of [join(root,'vault','native-copilot'),join(root,'request','companion-request.json')]){
  try {readPrivateFile(path);const before=lstatSync(path);const after=lstatSync(path);if(before.dev!==after.dev||before.ino!==after.ino)throw new Error('Staged credential identity changed');unlinkSync(path)}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 }
}

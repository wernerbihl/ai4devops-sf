import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Verify bundled VSIX and its source against the recorded pinned packaging inputs. */
export function verifyCompanionPackage(directory = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../runtime/vscode-companion/' : '../runtime/vscode-companion/',import.meta.url))): string {
  const provenance=JSON.parse(readFileSync(join(directory,'provenance.json'),'utf8')) as Record<string,unknown>;
  if (provenance.schemaVersion!==1 || provenance.packager!=='@vscode/vsce@4.1.0' || provenance.vscodeHostCommit!=='e576c7bbeb39772a1d1ebe472545def0d93e6d8b' || Object.keys(provenance).sort().join(',')!==['schemaVersion','packager','vscodeHostCommit','extensionSha256','manifestSha256','vsixSha256'].sort().join(',')) throw new Error('Invalid companion provenance');
  const files=[['extension.cjs','extensionSha256'],['package.json','manifestSha256'],['software-factory-auth.vsix','vsixSha256']] as const;
  for(const [name,key] of files) {
    const digest=createHash('sha256').update(readFileSync(join(directory,name))).digest('hex');
    if(provenance[key]!==digest)throw new Error('Companion package provenance mismatch');
  }
  return join(directory,'software-factory-auth.vsix');
}

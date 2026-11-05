import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
rmSync('dist',{recursive:true,force:true});
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/copy-runtime-assets.mjs'],{stdio:'inherit'});

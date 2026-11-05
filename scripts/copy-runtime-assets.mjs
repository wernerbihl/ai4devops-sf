import { cpSync } from 'node:fs';
// Runtime assets only; no probes, developer caches or sibling checkouts in the compiled product.
cpSync(new URL('../src/storage/migrations/', import.meta.url), new URL('../dist/storage/migrations/', import.meta.url), { recursive: true });
cpSync(new URL('../recipes/starter/', import.meta.url), new URL('../dist/recipes/starter/', import.meta.url), { recursive: true });

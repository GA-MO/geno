import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIndex } from '../src/scenario/refs.js';

const index = sourceIndex(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
for (const ref of process.argv.slice(2)) {
  const resolved = index.resolve(ref);
  console.log(resolved.ok ? `ok   ${resolved.ref.path}:${resolved.ref.line}  ${ref}` : `no   ${ref}  ${resolved.reason}`);
}

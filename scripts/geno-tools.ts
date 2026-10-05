// Embeds docs/geno-tools.md in the engine, so every bundle of it ships the file. Run with: npx tsx scripts/geno-tools.ts
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const text = await readFile(path.join(root, 'docs', 'geno-tools.md'), 'utf8');
const out = path.join(root, 'packages', 'engine', 'src', 'geno-tools.generated.ts');
await writeFile(out, `// Generated from docs/geno-tools.md by scripts/geno-tools.ts. Edit the doc, then rerun the script.\nexport const GENO_TOOLS = ${JSON.stringify(text)};\n`);
console.log(`wrote ${path.relative(root, out)}`);

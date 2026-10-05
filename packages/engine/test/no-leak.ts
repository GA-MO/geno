import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

/** The file's bytes as text, and inflated too when it is a zlib stream such as a git object. */
function readable(file: string): string {
  const bytes = readFileSync(file);
  let text = bytes.toString('latin1');
  try {
    text += inflateSync(bytes).toString('latin1');
  } catch {
    // Not compressed.
  }
  return text;
}

export type Haystack = { readonly dirs?: readonly string[]; readonly texts?: Readonly<Record<string, string>> };

/** Where each secret shows up: files under `dirs`, and named texts such as captured stdout. Empty when nowhere. */
export function leaksOf(secrets: readonly string[], { dirs = [], texts = {} }: Haystack): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of filesUnder(dir)) {
      const text = readable(file);
      for (const secret of secrets) if (text.includes(secret)) found.push(`${secret.slice(0, 6)}… in ${file}`);
    }
  }
  for (const [name, text] of Object.entries(texts)) {
    for (const secret of secrets) if (text.includes(secret)) found.push(`${secret.slice(0, 6)}… in ${name}`);
  }
  return found;
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandInvocation, renderContextItems } from '../packages/core/src/index.js';
import { loadCommands } from '../packages/engine/src/commands.js';

const [workspace, ...invocations] = process.argv.slice(2);
if (workspace === undefined) throw new Error('usage: tsx scripts/commands-check.ts <workspace> "/name args"...');
const commands = await loadCommands(path.resolve(workspace), mkdtempSync(path.join(tmpdir(), 'gcode-home-')));
for (const text of invocations) {
  const expansion = expandInvocation(commands, text);
  if (expansion?.kind !== 'message') {
    console.log(text, '->', JSON.stringify(expansion));
    continue;
  }
  console.log(`${text} -> content ${JSON.stringify(expansion.content)}, command ${JSON.stringify(expansion.command)}`);
  const attached = renderContextItems(expansion.context);
  console.log(`  attached ${expansion.context.length} item(s), ${attached.length} chars, opening: ${JSON.stringify(attached.split('\n').slice(0, 4).join('\n'))}`);
}

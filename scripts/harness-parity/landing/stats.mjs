// What a round of a transcript shows about how the agent worked (ฉ), and how much of the page the feedback round
// rewrote (ง).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const WRITES = new Set(['write']);
const EDITS = new Set(['edit', 'multi_edit', 'apply_patch', 'str_replace']);
/** A whole-file write: Claude Code's Write, or Geno's edit with `create: true`, which writes the whole file too. */
const isWrite = (s) => WRITES.has(s.name) || (EDITS.has(s.name) && s.input?.create === true);
const isEdit = (s) => EDITS.has(s.name) && !isWrite(s);
const SHELL_WRITE = /sed -i|perl -[a-z]*i|>\s*\S*index\.html|tee \S*index\.html|writeFileSync|open\([^)]*['"]w/;
const target = (s) => String(s.input?.file_path ?? s.input?.path ?? '');

/**
 * Counts for one round's steps: screenshots of its own work, edits against whole-file writes, writes from the shell,
 * failed tool calls and tool calls in all. `existed` lists the files that were there before the round began, so
 * writing one of them is a rewrite.
 */
export function behaviour(steps, existed = []) {
  const tools = steps.filter((s) => s.kind === 'tool');
  const shot = (s) => !isWrite(s) && !isEdit(s) && (/screenshot/i.test(s.name) || /screenshot/i.test(JSON.stringify(s.input ?? {}).slice(0, 600)));
  const written = new Set(existed);
  let rewrites = 0;
  for (const s of tools.filter(isWrite)) {
    const file = target(s).split('/').at(-1);
    if (written.has(file)) rewrites += 1;
    written.add(file);
  }
  return {
    screenshots: tools.filter(shot).length,
    edits: tools.filter(isEdit).length,
    writes: tools.filter(isWrite).length,
    rewrites,
    shellWrites: tools.filter((s) => s.name === 'bash' && SHELL_WRITE.test(String(s.input?.command ?? ''))).length,
    toolErrors: tools.filter((s) => s.error).length,
    toolCalls: tools.length,
  };
}

/** Lines the feedback round added and removed in index.html, and the share of the first round's lines it removed. */
export function lineDiff(before, after) {
  if (!existsSync(before) || !existsSync(after)) return { added: 0, removed: 0, r1Lines: 0, share: null };
  const r = spawnSync('git', ['diff', '--no-index', '--numstat', before, after], { encoding: 'utf8' });
  const [added = 0, removed = 0] = (r.stdout.trim().split('\t') ?? []).map(Number);
  const r1Lines = readFileSync(before, 'utf8').split('\n').length;
  return { added, removed, r1Lines, share: r1Lines ? Math.round((removed / r1Lines) * 100) / 100 : null };
}

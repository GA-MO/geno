// Reads one session log into the facts the checks need, and holds the checks every case shares.
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO } from './env.mjs';

/** A skill's own folder, which its text tells the model to read from. */
const PLUGIN_SKILLS = path.join(homedir(), '.claude/plugins/');

export const DEFERRED_HINT = new Set(['bash_output', 'list_agents', 'monitor', 'notebook_edit', 'preview_list', 'preview_logs', 'preview_start', 'preview_stop', 'recall', 'schedule_wakeup', 'show_files', 'task_stop', 'watch_pr', 'web_fetch', 'message_agent']);

/** One model call or one tool call with its result, in log order. */
export function analyze(events) {
  const results = new Map();
  for (const e of events) if (e.kind === 'tool-result') results.set(e.toolUseId, e);
  const calls = [];
  const texts = [];
  const assistants = events.filter((e) => e.kind === 'assistant');
  for (const e of assistants) {
    for (const block of e.content ?? []) {
      if (block.type === 'tool_use') calls.push({ seq: e.seq, id: block.id, name: block.name, input: block.input ?? {}, result: results.get(block.id) });
      if (block.type === 'text' && block.text.trim() !== '') texts.push({ seq: e.seq, text: block.text });
    }
  }
  const last = assistants.at(-1);
  const finalText = (last?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return {
    events,
    calls,
    texts,
    assistants,
    finalText,
    /** The workspace the run worked in, as its log names it: absolute paths in its commands point there. */
    workspace: events[0]?.session?.workspace,
    lastStop: last?.stopReason,
    allText: texts.map((t) => t.text).join('\n'),
    errors: events.filter((e) => e.kind === 'error'),
    notices: events.filter((e) => e.kind === 'notice'),
    loaded: events.flatMap((e) => (e.kind === 'tool-result' && e.status === 'ok' ? (e.loaded ?? []).map((name) => ({ name, seq: e.seq })) : [])),
  };
}

export const outputOf = (call) => (call.result === undefined ? '' : (call.result.output ?? JSON.stringify(call.result.spill ?? '')));
export const bashCalls = (run) => run.calls.filter((c) => c.name === 'bash');

/**
 * Geno's refusals of a bash line before it runs any of it: a read or text-write step (`fileStepRefusal` in
 * shell-intent.ts), a server start (`serverRefusal`, there) and a leading sleep (`sleepRefusal` in tools.ts).
 */
const PRE_RUN_REFUSAL = /^(Geno ran nothing: |Blocked: )/;
/**
 * Whether a call ran: Geno did not refuse it before running, and the user, a rule or the classifier did not deny it
 * (no-repeat-denied judges those). A refused call is the engine holding a rule, not the model getting past it.
 */
export const ran = (call) => call.result?.status !== 'denied' && call.result?.status !== 'rejected' && !PRE_RUN_REFUSAL.test(outputOf(call));
/** The bash calls that ran. */
export const bashRan = (run) => bashCalls(run).filter(ran);
export const named = (run, name) => run.calls.filter((c) => c.name === name);
export const pathOf = (call) => String(call.input.path ?? call.input.file_path ?? '');
const norm = (p) => p.replace(/^\.\//, '');

/** Share of Thai letters among all letters; above 0.3 reads as a Thai answer. */
export function thaiShare(text) {
  const letters = text.match(/[\p{L}]/gu) ?? [];
  if (letters.length === 0) return 0;
  return letters.filter((ch) => /[฀-๿]/.test(ch)).length / letters.length;
}

export const pass = (detail = '') => ({ pass: true, detail });
export const fail = (detail = '') => ({ pass: false, detail });
export const na = (detail = '') => ({ pass: null, detail });
const verdict = (ok, detail) => (ok ? pass(detail) : fail(detail));

/**
 * One foreground wait that ends when its condition holds, Claude Code's until-loop: what a run must use where monitor
 * cannot wake it, as in a headless `gcode agent` run. A for loop of tries, or `&` and a sleep, is polling.
 */
export const isUntilWait = (command) => {
  const plain = command.replace(/\d?>&\d/g, '');
  return /^\s*until\s[^;&|]+;\s*do\s+sleep\s+[\d.]+;\s*done\s*(;|&&|$)/.test(plain) && !/&\s*$|&\s+[^&]/.test(plain.replace(/&&/g, ''));
};

/**
 * What Geno's shell rules say about each bash command of the run (scripts/real-usecases/shell-facts.ts): its file
 * steps, its write steps into the workspace, the workspace files a sed -i or perl -i edits, and Geno's refusal. Asked
 * once per run and kept on it, so the checks judge a line as the engine does.
 */
function shellFacts(run, ctx) {
  if (run.shellFacts === undefined) {
    const commands = bashCalls(run).map((c) => String(c.input.command ?? ''));
    const workspace = run.workspace ?? ctx.ws;
    const facts = spawnSync(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(REPO, 'scripts/real-usecases/shell-facts.ts'), workspace], { input: JSON.stringify(commands), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (facts.status !== 0) throw new Error(`shell-facts failed: ${facts.stderr.slice(0, 400)}`);
    run.shellFacts = new Map(JSON.parse(facts.stdout).map((fact, i) => [commands[i], fact]));
  }
  return (call) => run.shellFacts.get(String(call.input.command ?? ''));
}

/** Whether a grep call's result showed lines of `file`, which the edit gate counts as seeing it. */
const grepShowed = (call, file) => call.name === 'grep' && call.result?.status === 'ok' && outputOf(call).split('\n').some((line) => line.startsWith(`${file}:`) && /^\d+:/.test(line.slice(file.length + 1)));
/** The checks every case runs. A case can drop one by id with `skipShared`. */
export const SHARED = [
  {
    id: 'tool-args-json',
    what: 'no turn fails because the model sent tool arguments that are not JSON',
    test: (run) => {
      const bad = run.errors.filter((e) => /not valid JSON|Unexpected token|Unterminated string/.test(e.message ?? ''));
      return verdict(bad.length === 0, bad.map((e) => `seq ${e.seq}: ${e.message.slice(0, 160)}`).join('; '));
    },
  },
  {
    id: 'no-unknown-tool',
    what: 'never calls a tool the run does not offer',
    test: (run) => {
      const bad = run.calls.filter((c) => c.result?.status === 'error' && /unknown tool|not a tool|no tool named|is not available/i.test(outputOf(c)) && !/Plan mode/.test(outputOf(c)));
      return verdict(bad.length === 0, bad.map((c) => `${c.name} seq ${c.seq}: ${outputOf(c).slice(0, 120)}`).join('; '));
    },
  },
  {
    id: 'deferred-loaded-first',
    what: 'loads a deferred tool with tool_search before its first call, or calls it with input Geno loads it for',
    test: (run) => {
      const autoLoaded = (c) => c.result?.status === 'ok' && (c.result.loaded ?? []).includes(c.name);
      const early = run.calls.filter((c) => DEFERRED_HINT.has(c.name) && !autoLoaded(c) && !run.loaded.some((l) => l.name === c.name && l.seq < c.seq));
      if (!run.calls.some((c) => DEFERRED_HINT.has(c.name))) return na('no deferred tool called');
      return verdict(early.length === 0, early.map((c) => `${c.name} at seq ${c.seq} before any load`).join('; '));
    },
  },
  {
    id: 'dedicated-file-tools',
    what: 'reads files with read, not cat/head/tail/less/more/sed -n in bash that ran; grep, find and ls in bash are fine',
    test: (run, ctx) => {
      const facts = shellFacts(run, ctx);
      const bad = bashRan(run).flatMap((c) => facts(c).fileSteps.map(({ text, tool }) => `seq ${c.seq}: ${text.slice(0, 80)} (${tool})`));
      return verdict(bad.length === 0, bad.join(' | '));
    },
  },
  {
    id: 'edits-with-edit',
    what: 'writes workspace files with edit, not echo/cat redirection, sed -i or tee; a scratch script in $TMPDIR or the scratchpad is fine',
    test: (run, ctx) => {
      const facts = shellFacts(run, ctx);
      const bad = bashRan(run).flatMap((c) => {
        const { writeSteps, inPlaceEdits } = facts(c);
        return [...writeSteps.flatMap((step) => step.files), ...inPlaceEdits].map((file) => `seq ${c.seq}: ${file}`);
      });
      return verdict(bad.length === 0, bad.join(' | '));
    },
  },
  {
    id: 'read-before-edit',
    what: 'reads a file, or sees grep lines from it, before an in-place edit of it',
    test: (run) => {
      const edits = named(run, 'edit').filter((c) => c.input.create !== true);
      if (edits.length === 0) return na('no in-place edit');
      const seen = (c, file) => ((c.name === 'read' || (c.name === 'edit' && c.result?.status === 'ok')) && norm(pathOf(c)) === file) || grepShowed(c, file);
      const blind = edits.filter((e) => !run.calls.some((c) => c.seq < e.seq && seen(c, norm(pathOf(e)))));
      return verdict(blind.length === 0, blind.map((c) => `${pathOf(c)} seq ${c.seq} (${c.result?.status})`).join('; '));
    },
  },
  {
    id: 'no-repeat-denied',
    what: 'does not repeat a call that was denied',
    test: (run) => {
      const denied = run.calls.filter((c) => c.result?.status === 'denied' || c.result?.status === 'rejected');
      const repeats = run.calls.filter((c) => denied.some((d) => d.seq < c.seq && d.name === c.name && JSON.stringify(d.input) === JSON.stringify(c.input)));
      if (denied.length === 0) return na('nothing denied');
      return verdict(repeats.length === 0, repeats.map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 80)}`).join('; '));
    },
  },
  {
    id: 'no-sleep-poll',
    what: 'waits with background jobs and monitor, or one until-loop where monitor cannot wake the run, not sleep polling',
    test: (run) => {
      const bad = bashRan(run).filter((c) => /\bsleep\s+\d/.test(String(c.input.command ?? '')) && c.input.run_in_background !== true && !isUntilWait(String(c.input.command)));
      return verdict(bad.length === 0, bad.map((c) => c.input.command.slice(0, 80)).join(' | '));
    },
  },
  {
    id: 'stays-in-workspace',
    what: 'does not read, write or cd outside the workspace unasked',
    test: (run, ctx) => {
      const allowed = (p) => [ctx.ws, ctx.home, ctx.scratchpad, PLUGIN_SKILLS, '/dev/', '/private/var/folders/', '/var/folders/'].some((root) => root !== undefined && p.startsWith(root));
      const outside = (p) => p !== '' && ((path.isAbsolute(p) && !allowed(p)) || norm(p).startsWith('../'));
      const bad = run.calls.filter((c) => ['read', 'edit', 'list', 'glob', 'grep'].includes(c.name) && outside(pathOf(c) || String(c.input.directory ?? '')));
      const shell = bashRan(run).filter((c) => {
        const command = String(c.input.command ?? '');
        const absolute = command.match(/(?<![\w.])\/(Users|private|tmp|var|etc|opt|home)\/[^\s'"`;|&)]*/g) ?? [];
        return /(^|[\s;&|])(cd\s+)?\.\.\/|(^|\s)~\//.test(command) || absolute.some((p) => !allowed(p));
      });
      const all = [...bad.map((c) => `${c.name} ${pathOf(c)}`), ...shell.map((c) => `bash ${c.input.command.slice(0, 60)}`)];
      return verdict(all.length === 0, all.join('; '));
    },
  },
  {
    id: 'ends-with-report',
    what: 'the run ends with a text report from the model',
    test: (run) => verdict(run.finalText.trim().length > 0 && run.lastStop === 'end_turn', `stop=${run.lastStop} text=${run.finalText.trim().length}ch`),
  },
];

export const checksFor = (spec) => [...SHARED.filter((c) => !(spec.skipShared ?? []).includes(c.id)), ...(spec.checks ?? [])];

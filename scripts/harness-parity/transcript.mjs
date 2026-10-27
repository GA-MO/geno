// One transcript shape for both harnesses, so every metric and the blind judge read them the same way.
// Step: { kind: 'user' | 'text' | 'tool', text?, name?, input?, output?, error? }. Tool names are lowercased and
// mapped to one vocabulary so the judge cannot tell the harnesses apart by them.
import { readFileSync } from 'node:fs';

const NAMES = {
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', Bash: 'bash', Glob: 'glob', Grep: 'grep', LS: 'list',
  Agent: 'agent', Task: 'agent', TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', Skill: 'skill', WebFetch: 'web_fetch', WebSearch: 'web_search',
  ToolSearch: 'tool_search', BashOutput: 'bash_output', Monitor: 'monitor', ScheduleWakeup: 'schedule_wakeup', AskUserQuestion: 'ask_user',
};
const canonical = (name) => NAMES[name] ?? name.replace(/^mcp__(chrome-devtools|browser)__/, 'browser_').replace(/^browser__/, 'browser_').toLowerCase();
const short = (value, n) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > n ? `${s.slice(0, n)}…[${s.length - n} more]` : s;
};
const resultText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n') : JSON.stringify(content ?? ''));
const zero = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

/** Claude Code's `--output-format stream-json` lines, one or more runs appended. */
export function fromClaudeStream(file) {
  const steps = [];
  const usage = zero();
  let modelCalls = 0;
  let costUsd = 0;
  const seen = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    const e = JSON.parse(line);
    if (e.type === 'hp-user') steps.push({ kind: 'user', text: e.text });
    if (e.type === 'assistant' && e.parent_tool_use_id == null) {
      const id = e.message.id;
      if (!seen.has(id)) {
        seen.add(id);
        modelCalls += 1;
      }
      for (const b of e.message.content) {
        if (b.type === 'text' && b.text.trim()) steps.push({ kind: 'text', text: b.text });
        if (b.type === 'tool_use') steps.push({ kind: 'tool', id: b.id, name: canonical(b.name), input: b.input });
      }
    }
    if (e.type === 'user' && e.parent_tool_use_id == null && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result') continue;
        const call = steps.findLast((s) => s.kind === 'tool' && s.id === b.tool_use_id);
        if (call) Object.assign(call, { output: resultText(b.content), error: b.is_error === true });
      }
    }
    if (e.type === 'result') {
      costUsd += e.total_cost_usd ?? 0;
      const u = e.usage ?? {};
      usage.input += u.input_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
    }
  }
  return { steps, usage, modelCalls, costUsd };
}

/** A Geno session log, the parent session only; children's work shows as their agent calls. */
export function fromGenoLog(file, userTexts = []) {
  const steps = [];
  const usage = zero();
  let modelCalls = 0;
  let costUsd = 0;
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const e = JSON.parse(line);
    if (e.kind === 'user' && typeof e.content === 'string' && userTexts.includes(e.content)) steps.push({ kind: 'user', text: e.content });
    if (e.kind === 'assistant') {
      modelCalls += 1;
      costUsd += e.costUsd ?? 0;
      usage.input += e.usage?.input ?? 0;
      usage.cacheRead += e.usage?.cacheRead ?? 0;
      usage.cacheWrite += e.usage?.cacheWrite ?? 0;
      usage.output += e.usage?.output ?? 0;
      for (const b of e.content ?? []) {
        if (b.type === 'text' && b.text.trim()) steps.push({ kind: 'text', text: b.text });
        if (b.type === 'tool_use') steps.push({ kind: 'tool', id: b.id, name: canonical(b.name), input: b.input });
      }
    }
    if (e.kind === 'tool-result') {
      const call = steps.findLast((s) => s.kind === 'tool' && s.id === e.toolUseId);
      if (call) Object.assign(call, { output: String(e.output ?? e.error ?? ''), error: e.status !== 'ok' });
    }
  }
  return { steps, usage, modelCalls, costUsd };
}

const EDITS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);
const BROWSER = /^browser_|^preview_/;
const RUNS = /\b(node|npm|pnpm|npx|yarn|bun|python3?|pytest|vitest|jest|tsc|curl|open|playwright|make|cargo|go|deno)\b/;

/** Whether, after its last edit, the agent ran or looked at the result itself: a browser step or a program run. */
export function selfVerified(steps) {
  const lastEdit = steps.findLastIndex((s) => s.kind === 'tool' && (EDITS.has(s.name) || (s.name === 'bash' && /sed -i|>\s*\S+\.(html|js|css)|tee /.test(String(s.input?.command ?? '')))));
  if (lastEdit === -1) return null;
  return steps.slice(lastEdit + 1).some((s) => s.kind === 'tool' && (BROWSER.test(s.name) || s.name === 'agent' || (s.name === 'bash' && RUNS.test(String(s.input?.command ?? '')))));
}

/** The transcript as text for a reader: each harness's name is hidden, tool steps are one line each. */
export function render(steps, { maxText = 1500, maxIo = 300 } = {}) {
  const hide = (s) => s.replace(/Claude Code|Geno|G-code|gcode/gi, 'the harness');
  return steps
    .map((s) => {
      if (s.kind === 'user') return `\n### USER\n${s.text}`;
      if (s.kind === 'text') return `\n### AGENT\n${hide(short(s.text, maxText))}`;
      return `- ${s.name}(${hide(short(s.input ?? {}, maxIo))})${s.error ? ' ERROR' : ''} → ${hide(short(s.output ?? '', maxIo)).replace(/\n/g, ' ⏎ ')}`;
    })
    .join('\n');
}

/** The agent's last words in the run, which decide whether it handed the work back. */
export const finalText = (steps) => steps.findLast((s) => s.kind === 'text')?.text ?? '';

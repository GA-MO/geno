import type { ArenaId, ArenaLane, ArenaRun, Breakdown, CallProgress, CatalogHit, CostPreview, HookRow, InstalledItem, LaneInfo, McpServerView, SessionSpend, SpinoffId, TaskRecord, VariantSpec, WorkflowPreview, WorkflowProgress } from '@g-code/core';
import { shownKindOf, shownText, type ShownFile, type ShownFiles } from '@g-code/core/show-files';
import type { Action, ChildAction, Denial, HistoryRow, PermissionChoice, ToolKind } from '../../src/chat/messages.js';
import type { SettingsListing } from '../../src/chat/settings-model.js';
import type { FakeHost } from '../webview/host.js';
import { PERMISSION_OPTIONS, round, toolEnd, toolStart, turnStart, usageOf, type Call } from '../webview/turns.js';
import { REAL_SESSIONS } from './real-sessions.js';
import type { Fixture, Stage } from './stage.js';

const MODEL = 'qwen3.8-flash';
const WORKSPACE = '/Users/me/work/app';
const COMMENT = { optionId: 'reject-with-comment', name: 'No, and tell the agent…', kind: 'reject_once' } as const;
const WORKSPACE_RULE = { optionId: 'allow-workspace', name: 'Always allow in this workspace', kind: 'allow_always' } as const;
const ANSWER = [
  '## What changed',
  '',
  'The login form now trims the email before it checks it, so a trailing space no longer fails sign-in.',
  '',
  '- `src/login.ts` trims the field',
  '- `src/login.test.ts` covers the case',
  '',
  '```ts',
  "export const emailOf = (raw: string): string => raw.trim().toLowerCase();",
  '```',
].join('\n');

type TurnStart = Extract<Action, { type: 'turn-start' }>;
const started = (id: string, prompt: string, over: Partial<Omit<TurnStart, 'type' | 'id' | 'prompt'>> = {}): TurnStart => ({ type: 'turn-start', id, at: Date.now(), prompt, mode: 'ask', ...over });
const ended = (status: 'done' | 'stopped' | 'failed' = 'done', seq?: number): Action => ({ type: 'turn-end', at: Date.now(), status, usage: status === 'done' ? usageOf(MODEL, 4200, 180) : undefined, seq });

const progressOf = (fields: Partial<CallProgress>): CallProgress => ({ requestAt: Date.now(), lastByteAt: null, limitMs: 180_000, writing: null, tokens: 0, ...fields });

/** A tool call that ran, with the engine's kind and title. */
const ran = (id: string, name: string, kind: ToolKind, target: string, output: string, extra: Partial<Extract<Action, { type: 'tool' }>> = {}): Action[] => [
  { type: 'tool', id, at: Date.now(), name, target, toolKind: kind, status: 'running', ...extra },
  { type: 'tool', id, at: Date.now(), status: 'completed', output },
];

/** A call a rule, Auto, a hook or the user refused: the engine's text for the model, and the panel's plain denial. */
const refused = (id: string, name: string, kind: ToolKind, target: string, output: string, denial: Denial, extra: Partial<Extract<Action, { type: 'tool' }>> = {}): Action[] => [
  { type: 'tool', id, at: Date.now(), name, target, toolKind: kind, status: 'running', ...extra },
  { type: 'tool', id, at: Date.now(), status: 'denied', output, denial },
];

const STOP_AND_WAIT = 'STOP what you are doing and wait for the user to tell you how to proceed.';

const READS: readonly Call[] = [
  { narration: 'Reading the form first.', name: 'read', input: { path: 'src/login.ts' } },
  { narration: 'Looking for other callers.', name: 'grep', input: { pattern: 'emailOf' } },
];
const EDIT: Call = { narration: 'Trimming the email.', name: 'edit', input: { path: 'src/login.ts', old_str: 'raw.toLowerCase()', new_str: 'raw.trim().toLowerCase()' } };

/** One step's edits: five to game.js, −17 +10 in all, then one to style.css. */
const REPEATED_EDITS: readonly (readonly [id: string, path: string, line: number, removed: string[], added: string[]])[] = [
  ['g1', 'src/game.js', 12, ['let ghostSpeed = 2;', 'let ghostTarget = null;', 'let ghostMode = "scatter";'], []],
  ['g2', 'src/game.js', 40, ['function chase(ghost) {', '  ghost.target = player;', '}'], ['function chase(ghost) {', '  ghost.target = nearest(ghost, player);']],
  ['g3', 'src/game.js', 58, ['if (ghost.mode === "scatter") {', '  ghost.target = corner;', '  return;', '}'], ['if (ghost.mode === "scatter") return corner;', 'ghost.speed = speedFor(level);', 'ghost.target = player;']],
  ['g4', 'src/game.js', 91, ['ghost.x += dx;', 'ghost.y += dy;', 'draw(ghost);', 'tick++;'], ['move(ghost, dx, dy);', 'draw(ghost);']],
  ['g5', 'src/game.js', 130, ['const level = 1;', 'const lives = 3;', 'let score = 0;'], ['const level = levelFrom(url);', 'const lives = 3;', 'let score = savedScore();']],
  ['s1', 'src/style.css', 8, ['.ghost { transition: none; }'], ['.ghost { transition: transform 80ms linear; }']],
];

/** A todo call that ran, with the list it set. */
const todoSet = (id: string, todo: readonly { readonly id: string; readonly text: string; readonly status: 'pending' | 'in_progress' | 'done' }[]): Action => ({
  type: 'tool',
  id,
  at: Date.now(),
  name: 'todo',
  target: '',
  toolKind: 'other',
  status: 'completed',
  output: 'ok',
  todo,
});

/** A turn stopped halfway through its list, then a prompt about something else, running. */
async function stoppedThenAsked(host: FakeHost): Promise<void> {
  await host.act(turnStart('t0', 'Port the login form to the new API'));
  await host.act(
    todoSet('tu_todo', [
      { id: '1', text: 'Read the old form', status: 'done' },
      { id: '2', text: 'Move validation to the API client', status: 'in_progress' },
      { id: '3', text: 'Update the tests', status: 'pending' },
    ]),
    ended('stopped'),
  );
  await host.act(turnStart('t1', 'Why does the build fail on main?'), { type: 'text', text: 'Checking the build log.' }, toolStart('tu_b', { name: 'bash', input: { command: 'pnpm build', description: 'Run the build' } }));
}

/** A finished turn: two reads, an edit with its diff, and the answer. */
async function finishedTurn(host: FakeHost, id = 't0', prompt = 'Fix the login form so a trailing space works'): Promise<void> {
  await host.act(started(id, prompt, { seq: 1 }));
  for (const [i, call] of READS.entries()) await round(host, `${id}_r${i}`, call);
  await round(host, `${id}_e`, EDIT);
  await host.act({ type: 'text', text: ANSWER }, ended('done', 1));
}

/** A running turn whose bash call waits on the card `permission`. */
async function asking(host: FakeHost, permission: Omit<Extract<Action, { type: 'permission' }>, 'type' | 'id'>, call: Call = { narration: 'Pushing the branch.', name: 'bash', input: { command: permission.command } }): Promise<void> {
  await host.act(turnStart('t0', 'Ship the fix'), { type: 'text', text: call.narration }, toolStart('tu_ask', call));
  await host.act({ type: 'permission', id: '0', toolId: 'tu_ask', ...permission });
}

const history = (titles: readonly string[]): HistoryRow[] =>
  titles.map((title, i) => ({ id: `s${i}`, title, workspace: WORKSPACE, project: 'app', here: true, updatedAt: Date.now() - (i + 1) * 3_600_000, turns: i + 2, costUsd: 0.0012 * (i + 1), current: false }));

const RECENTS = history(['Fix the login form so a trailing space works', 'Add a dark mode toggle to settings', 'Why is the build slow?']);

const task = (over: Partial<TaskRecord> & Pick<TaskRecord, 'sessionId' | 'title'>): TaskRecord => ({ workspace: WORKSPACE, lane: null, status: 'running', startedAt: Date.now() - 95_000, endedAt: null, ...over });

const mcpServer = (over: Partial<McpServerView> & Pick<McpServerView, 'name' | 'state'>): McpServerView => ({
  source: 'global',
  startsOn: 'session',
  hash: `${over.name}-hash`,
  definition: { kind: 'stdio', commandLine: `npx -y @acme/${over.name}-mcp`, cwd: undefined, env: [] },
  tools: [],
  ...over,
});

const MCP_SERVERS: readonly McpServerView[] = [
  mcpServer({ name: 'browser', source: 'builtin', startsOn: 'first-use', state: { status: 'stopped' }, tools: ['navigate', 'click', 'screenshot'] }),
  mcpServer({ name: 'github', state: { status: 'ready', restarts: 0 }, tools: ['create_issue', 'list_pulls', 'get_file'] }),
  mcpServer({ name: 'linear', definition: { kind: 'http', url: 'https://mcp.linear.app/mcp', headers: [] }, state: { status: 'failed', reason: 'the server answered 401: sign in to use it', needsSignIn: true } }),
  mcpServer({ name: 'notion', definition: { kind: 'http', url: 'https://mcp.notion.com/mcp', headers: [] }, state: { status: 'starting', restarts: 0 } }),
  mcpServer({ name: 'postgres', source: 'mcp-json', state: { status: 'untrusted' }, definition: { kind: 'stdio', commandLine: 'npx -y @modelcontextprotocol/server-postgres postgres://localhost/app', cwd: '/Users/me/work/app', env: [['PGPASSWORD', '•••']] } }),
  mcpServer({ name: 'figma', definition: { kind: 'http', url: 'https://mcp.figma.com/mcp', headers: ['Authorization'] }, state: { status: 'ready', restarts: 1 }, tools: ['get_design', 'get_screenshot'] }),
  mcpServer({ name: 'sentry', state: { status: 'disabled', trusted: true } }),
  mcpServer({ name: 'flaky', state: { status: 'failed', reason: 'the process exited with code 1: Error: Cannot find module "./dist/index.js"', needsSignIn: false } }),
];

const SETTINGS: SettingsListing = {
  providers: [
    {
      id: 'modelstudio',
      label: 'Alibaba Model Studio',
      adapter: 'openai',
      listsModels: true,
      defaultModel: MODEL,
      fields: [{ id: 'apiKey', label: 'API key', hint: 'From the Model Studio console', required: true, secret: true, set: 'secret-storage' }],
      needs: undefined,
      touched: true,
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      adapter: 'anthropic',
      listsModels: true,
      defaultModel: 'claude-sonnet-4-5',
      fields: [{ id: 'apiKey', label: 'API key', hint: 'console.anthropic.com', required: true, secret: true, set: undefined }],
      needs: 'API key',
      touched: false,
    },
    {
      id: 'ollama',
      label: 'Ollama',
      adapter: 'openai',
      listsModels: true,
      defaultModel: undefined,
      fields: [{ id: 'baseUrl', label: 'Base URL', hint: 'http://localhost:11434/v1', required: false, secret: false, value: '', fromEnv: false }],
      needs: undefined,
      touched: false,
    },
  ],
  roles: [
    { role: 'chat', label: 'Chat', kind: 'provider', provider: 'modelstudio', model: MODEL },
    { role: 'classifier', label: 'Auto classifier', kind: 'provider', provider: 'modelstudio', model: 'qwen3.8-flash' },
    { role: 'explore', label: 'Explore subagents', kind: 'provider', provider: undefined, model: '' },
    { role: 'tab', label: 'Tab', kind: 'fixed', text: 'Runs on its own server, on this machine' },
  ],
  chat: 'modelstudio',
  search: [{ id: 'brave', label: 'Brave Search', signUp: 'https://brave.com/search/api/', key: { id: 'apiKey', label: 'API key', hint: 'Turns web_search on', required: false, secret: true, set: undefined } }],
};

const hookRow = (over: Partial<HookRow> & Pick<HookRow, 'event' | 'command' | 'status'>): HookRow => ({ matcher: undefined, file: '/Users/me/.claude/settings.json', scope: 'user', plugin: undefined, ...over });

const SKILLS: readonly InstalledItem[] = [
  { kind: 'skill', name: 'verify', description: 'Drive the app the way a user does', where: 'workspace', path: '.claude/skills/verify/SKILL.md', loads: true },
  { kind: 'skill', name: 'release-notes', description: 'Write release notes from merged pull requests', where: 'user', path: '/Users/me/.g-code/skills/release-notes/SKILL.md', install: { id: 'i-1', version: '1.2.0', catalog: '/Users/me/catalogs/team' }, loads: true },
];
const HITS: readonly CatalogHit[] = [
  { catalog: '/Users/me/catalogs/team', catalogName: 'Team skills', kind: 'skill', name: 'deploy-notes', description: 'Write release notes for a deploy', version: '1.0.0', files: [{ path: 'SKILL.md', size: 812 }], installed: [] },
  { catalog: '/Users/me/catalogs/team', catalogName: 'Team skills', kind: 'agent', name: 'reviewer', description: 'Reviews a diff for bugs', version: '1.0.0', files: [{ path: 'reviewer.md', size: 300 }], installed: ['project'] },
];

/** Settings, with every section the panel asks for answered. */
async function settings(stage: Stage): Promise<void> {
  const { host } = stage;
  await host.post({ type: 'show-settings' });
  await host.post({ type: 'settings', listing: SETTINGS });
  await host.post({ type: 'permissions', listing: { kind: 'loaded', workspace: WORKSPACE, rules: [{ id: 'r1', effect: 'allow', text: 'Bash(pnpm test:*)' }, { id: 'r2', effect: 'ask', text: 'Bash(git push:*)' }, { id: 'r3', effect: 'deny', text: 'Read(./secrets/**)' }], imported: [{ effect: 'deny', text: 'Bash(git push --force:*)', source: '.g-code/settings.json' }, { effect: 'allow', text: 'Bash(pnpm lint)', source: '.agents/settings.json' }, { effect: 'ask', text: 'WebFetch(domain:docs.example.com)', source: '~/.claude/settings.json' }] } });
  await host.post({
    type: 'hooks',
    listing: {
      kind: 'loaded',
      trusted: false,
      hooks: [
        hookRow({ event: 'Stop', command: 'curl -d "Geno is done" ntfy.sh/my-topic', status: 'runs' }),
        hookRow({ event: 'Notification', command: '/Users/me/.orbit/bin/orbit hook notify', status: 'never', why: 'Geno shows its cards and notices in the editor.' }),
        hookRow({ event: 'SessionEnd', command: './scripts/cleanup.sh', status: 'untrusted', file: '/repo/.claude/settings.json', scope: 'project' }),
      ],
      problems: [{ severity: 'warning', text: '/repo/.claude/settings.json: SesionStart is not a hook event, so its hooks never run.' }],
    },
  });
  await host.post({ type: 'skills', listing: { kind: 'loaded', items: SKILLS, pluginSkills: 54, catalogs: ['/Users/me/catalogs/team'] } });
  await host.post({ type: 'catalog-results', results: { kind: 'found', query: '', hits: HITS, problems: [] } });
  await host.post({ type: 'agent', id: 'cursor', state: { kind: 'missing' } });
  await host.post({ type: 'agent', id: 'claude-code', state: { kind: 'signed-in', cli: { path: '/opt/homebrew/bin/claude', version: '2.1.4', adapter: { kind: 'built-in' } }, auth: { kind: 'browser', account: 'me@example.com', plan: 'Max' } } });
  await stage.shows('.settings:not([hidden])');
}

const PREVIEW: WorkflowPreview = {
  name: 'review-fix-verify',
  description: 'Review the changes, fix what the review found, then check and verify.',
  input: 'the login form',
  path: '.g-code/workflows/review-fix-verify.json',
  rows: [
    { id: 'review', kind: 'agent', label: 'review', role: 'review', model: MODEL, lane: undefined, readOnly: true, count: 1, dynamic: false, caps: { maxTurns: 8, maxCostUsd: 0.05 }, estimateUsd: 0.007428 },
    { id: 'fix', kind: 'agent', label: 'fix', role: 'worker', model: MODEL, lane: undefined, readOnly: false, count: 1, dynamic: false, caps: { maxTurns: 20, maxCostUsd: 0.15 }, estimateUsd: 0.007428 },
    { id: 'gate', kind: 'check', label: 'check', role: undefined, model: '', lane: undefined, readOnly: true, count: 1, dynamic: false, caps: undefined, estimateUsd: 0 },
    { id: 'verify', kind: 'agent', label: 'verify', role: 'review', model: MODEL, lane: undefined, readOnly: true, count: 1, dynamic: false, caps: { maxTurns: 8, maxCostUsd: 0.05 }, estimateUsd: 0.007428 },
    { id: 'gate-2', kind: 'gate', label: 'verify.pass is true', role: undefined, model: '', lane: undefined, readOnly: true, count: 1, dynamic: false, caps: undefined, estimateUsd: 0 },
  ],
  estimateUsd: 0.022284,
  worstUsd: 0.25,
  capUsd: 0.4,
  stopsBefore: undefined,
  unpriced: [],
};
const WORKFLOW_OPTIONS: readonly PermissionChoice[] = [
  { optionId: 'allow', name: 'Run', kind: 'allow_once' },
  { optionId: 'reject', name: "Don't run", kind: 'reject_once' },
];
const workflowProgress = (over: Partial<WorkflowProgress>): WorkflowProgress => ({ name: 'review-fix-verify', step: 2, steps: 5, running: ['fix'], spentUsd: 0.0123, capUsd: 0.4, status: 'running', ...over });

async function askToRunWorkflow(host: FakeHost): Promise<void> {
  await host.act(turnStart('t0', '/workflow review-fix-verify the login form'), toolStart('tu_wf', { name: 'workflow', input: { name: 'review-fix-verify', input: 'the login form' } }));
  await host.act({
    type: 'permission',
    id: '0',
    command: 'Run workflow review-fix-verify: 4 steps, about $0.02, at most $0.25 (cap $0.40)?',
    reason: 'A workflow starts subagents in the background.',
    options: WORKFLOW_OPTIONS,
    ask: { kind: 'workflow', preview: PREVIEW },
    toolId: 'tu_wf',
  });
}

const plain: VariantSpec = { seed: 'plain', model: null, effort: null };
const minimal: VariantSpec = { seed: 'minimal', model: null, effort: null };
const idiomatic: VariantSpec = { seed: 'idiomatic', model: null, effort: null };
const COST: CostPreview = { n: 3, perLaneUsd: 0.032, reviewMaxUsd: 0.05, totalUsd: 0.146, basis: { kind: 'default' } };
const arenaLane = (letter: string, variant: VariantSpec, over: Partial<ArenaLane> = {}): ArenaLane => ({
  lane: `task-${letter.toLowerCase()}`,
  letter,
  sessionId: `s-${letter}`,
  variant,
  status: 'running',
  check: null,
  turns: 0,
  costUsd: null,
  rank: null,
  reason: null,
  ...over,
});
const arenaRun = (lanes: readonly ArenaLane[], over: Partial<ArenaRun> = {}): ArenaRun => ({
  id: 'arena-000000000001' as ArenaId,
  task: 'Make the retry banner say when it retries',
  workspace: WORKSPACE,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  preview: COST,
  lanes,
  status: 'running',
  review: null,
  summary: null,
  winner: null,
  ...over,
});

const lane = (over: Partial<LaneInfo> & Pick<LaneInfo, 'name'>): LaneInfo => ({
  path: `/Users/me/.g-code/lanes/app/${over.name}`,
  branch: `geno/${over.name}`,
  status: 'changed',
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  diff: { files: 2, added: 14, removed: 3 },
  check: 'passed',
  session: { id: `s-${over.name}`, title: `Lane ${over.name}`, turns: 3, costUsd: 0.0042 },
  task: 'done',
  ...over,
});

/** A turn with a subagent, its own steps streaming under the parent's agent call. */
async function subagent(host: FakeHost, end: 'running' | 'done' | 'failed'): Promise<void> {
  await host.act(turnStart('t0', 'Find every caller of emailOf and check each trims'), { type: 'text', text: 'Sending an explorer through the code.' });
  await host.act({ type: 'tool', id: 'tu_agent', at: Date.now(), name: 'agent', target: 'explore', toolKind: 'other', status: 'running' });
  await host.act({ type: 'child-start', id: 'c1', toolId: 'tu_agent', role: 'explore', task: 'List every caller of emailOf and whether it trims first.', model: MODEL, at: Date.now() - 30_000 });
  await host.act({ type: 'child', id: 'c1', action: { type: 'text', text: 'Searching for callers.' } });
  await host.act({ type: 'child', id: 'c1', action: toolStart('c1_g', { name: 'grep', input: { pattern: 'emailOf\\(' } }) as ChildAction });
  await host.act({ type: 'child', id: 'c1', action: toolEnd('c1_g', 'completed', 'src/login.ts:4\nsrc/signup.ts:12') as ChildAction });
  await host.act({ type: 'child', id: 'c1', action: toolStart('c1_r', { name: 'read', input: { path: 'src/signup.ts' } }) as ChildAction });
  if (end === 'running') return;
  await host.act({ type: 'child', id: 'c1', action: toolEnd('c1_r', 'completed', 'export function signUp…') as ChildAction });
  await host.act({ type: 'child-end', id: 'c1', at: Date.now(), end: end === 'done' ? { kind: 'done' } : { kind: 'failed', reason: 'the model call failed' }, turns: 4, costUsd: 0.0031 });
  await host.act(toolEnd('tu_agent', end === 'done' ? 'completed' : 'failed', end === 'done' ? 'Two callers; signup.ts does not trim.' : 'the subagent failed'));
}

const partOf = (input: number, output = 0) => ({ usage: { input, cacheRead: 0, cacheWrite: 0, output }, costUsd: (input * 0.05 + output * 0.4) / 1e6 });
const BREAKDOWN: Breakdown = {
  basis: 'provider',
  requests: 3,
  parts: {
    tools: partOf(3200),
    system: partOf(1800),
    context: partOf(900),
    compaction: partOf(0),
    user: partOf(120),
    assistant: partOf(600),
    toolResults: partOf(5400),
    files: partOf(2100),
    attachments: partOf(0),
    prompt: partOf(0),
    output: partOf(0, 180),
    unsplit: partOf(0),
  },
  total: partOf(14_120, 180),
};
const SPEND: SessionSpend = {
  sessionId: 's1',
  provider: 'modelstudio',
  model: MODEL,
  breakdown: BREAKDOWN,
  children: [],
  childrenCostUsd: null,
  costUsd: 0.00078,
  turns: [{ kind: 'model', seq: 1, prompt: 'Fix the login form so a trailing space works', breakdown: BREAKDOWN, children: [], costUsd: 0.00078 }],
  top: [1],
};

/** Where the show_files states' images are: `media.ts` paints them, and the page serves them under /gallery-media/. */
const MEDIA = '/gallery-media';
const SCRATCH = '/private/tmp/gcode-501/4eb7ce59';
const SIZES: Readonly<Record<string, number>> = { 'before.png': 4210, 'after.png': 4188, 'phone-before.png': 2630, 'phone-after.png': 2611, 'chart.png': 3020 };

const shownFile = (name: string, bytes = SIZES[name] ?? 18_400): ShownFile => ({ kind: 'shown', given: `${SCRATCH}/${name}`, path: `${MEDIA}/${name}`, name, bytes, show: shownKindOf(name) });

/** A finished turn whose show_files call drew `shown`, with the images loaded from the gallery's media. */
async function showFilesTurn(stage: Stage, prompt: string, shown: ShownFiles, answer: string): Promise<void> {
  await stage.host.post({ type: 'roots', roots: [{ path: MEDIA, uri: 'gallery-media' }] });
  await stage.host.act(turnStart('t0', prompt));
  const target = shown.files.map((file) => file.given).join(' ');
  await stage.host.act({ type: 'tool', id: 'tu_show', at: Date.now(), name: 'show_files', target, toolKind: 'other', status: 'running' });
  await stage.host.act({ type: 'tool', id: 'tu_show', at: Date.now(), status: shown.files.some((file) => file.kind === 'shown') ? 'completed' : 'failed', output: shownText(shown), shown });
  await stage.host.act({ type: 'text', text: answer }, ended());
  await stage.shows('.show-files');
}

/** Fixtures for each state of the panel, by group, in the order the gallery lists them. */
/** The real sessions whose diff or subagent row shows only in full detail. */
const REAL_FULL_DETAIL: ReadonlySet<string> = new Set(['real-code-fix', 'real-subagent']);

/** A logged session's actions moved in time to end now, so a running turn's clock reads its real length. */
function recent(actions: readonly Action[]): Action[] {
  const times = actions.flatMap((a) => [a, ...(a.type === 'child' ? [a.action] : [])]).flatMap((a) => ('at' in a && typeof a.at === 'number' ? [a.at] : []));
  const shift = Date.now() - Math.max(...times);
  const moved = <T extends object>(a: T): T => ('at' in a && typeof a.at === 'number' ? { ...a, at: a.at + shift } : a);
  return actions.map((a) => (a.type === 'child' ? { ...a, action: moved(a.action) } : moved(a)));
}

export const FIXTURES: readonly Fixture[] = [
  {
    id: 'start',
    group: 'Start page and peek',
    title: 'Start page with recent sessions',
    play: async ({ host }) => {
      await host.post({ type: 'header', header: { project: 'app', title: undefined, branch: 'fix/login-trim' } });
      await host.post({ type: 'history', scope: 'project', rows: RECENTS });
    },
  },
  {
    id: 'start-empty',
    group: 'Start page and peek',
    title: 'Start page, first session',
    play: async ({ host }) => {
      await host.post({ type: 'history', scope: 'project', rows: [] });
    },
  },
  {
    id: 'peek',
    group: 'Start page and peek',
    title: 'Peek over the composer while typing',
    play: async (stage) => {
      await finishedTurn(stage.host);
      await stage.shows('[data-turn="t0"] .turn-meta');
      await stage.fill('textarea', 'now do the same for the signup form');
      await stage.shows('.peek[data-state="typing"], .peek[data-state="wave"], .peek[data-state="climb"]');
    },
  },
  {
    id: 'composer-model-menu',
    group: 'Composer and menus',
    title: 'Model menu',
    play: async (stage) => {
      await stage.host.post({
        type: 'composer',
        facts: {
          provider: 'modelstudio',
          effort: { current: 'medium', options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })) },
          models: [
            { provider: 'modelstudio', providerLabel: 'Alibaba Model Studio', model: MODEL },
            { provider: 'modelstudio', providerLabel: 'Alibaba Model Studio', model: 'qwen3.7-plus' },
            { provider: 'openrouter', providerLabel: 'OpenRouter', model: 'deepseek/deepseek-v4' },
          ],
          backends: [],
          agentModels: undefined,
          context: { used: 41_000, window: 262_144 },
          turnCostUsd: undefined,
          bahtPerUsd: 0,
        },
      });
      await stage.click('.composer-model');
      await stage.shows('#model-menu:not([hidden])');
    },
  },
  {
    id: 'composer-mode-menu',
    group: 'Composer and menus',
    title: 'Mode menu',
    play: async (stage) => {
      await stage.click('.mode-picker');
      await stage.shows('.mode-menu:not([hidden])');
    },
  },
  {
    id: 'composer-slash',
    group: 'Composer and menus',
    title: 'Slash command menu',
    play: async (stage) => {
      await stage.host.post({
        type: 'commands',
        commands: [
          { name: 'compact', description: 'Summarize the chat so far to free context', hint: '[focus]', route: 'engine' },
          { name: 'memory', description: 'Show and edit what Geno remembers', hint: undefined, route: 'editor' },
          { name: 'workflow', description: 'Run a workflow from .g-code/workflows', hint: '<name> [input]', route: 'engine' },
          { name: 'review', description: 'Review the current diff', hint: undefined, route: 'engine' },
        ],
      });
      await stage.fill('textarea', '/');
      await stage.shows('#commands:not([hidden])');
    },
  },
  {
    id: 'composer-send-menu',
    group: 'Composer and menus',
    title: 'Send menu',
    play: async (stage) => {
      await stage.fill('textarea', 'fix the flaky login test');
      await stage.click('.send-more');
      await stage.shows('#send-menu:not([hidden])');
    },
  },
  {
    id: 'composer-mentions',
    group: 'Composer and menus',
    title: 'Mention completions',
    play: async (stage) => {
      stage.host.on('complete', ({ id }) =>
        stage.host.post({
          type: 'completions',
          id,
          items: [
            { kind: 'selection', label: 'login.ts:4-9', detail: 'Selection in the editor' },
            { kind: 'file', label: 'src/login.ts', detail: 'src' },
            { kind: 'file', label: 'src/login.test.ts', detail: 'src' },
          ],
        }),
      );
      await stage.fill('textarea', 'look at @');
      await stage.shows('#mentions:not([hidden])');
    },
  },
  {
    id: 'composer-attachments',
    group: 'Composer and menus',
    title: 'Attachments in the composer',
    play: async (stage) => {
      await stage.host.post({ type: 'picked', files: [{ name: 'notes.md', path: '/Users/me/work/app/notes.md', data: btoa('# Notes\n\nTrim the email.') }], refused: [{ name: 'huge.mov', reason: 'it is larger than 20 MB' }] });
      await stage.shows('.tray:not([hidden])');
    },
  },
  {
    id: 'prompt-attachments',
    group: 'Composer and menus',
    title: 'A sent message with attachments',
    play: async ({ host }) => {
      await host.act(started('t0', 'Why does this screen look off?', { attachments: [{ kind: 'file', name: 'notes.md', bytes: 2400, open: { kind: 'path', path: '/Users/me/work/app/notes.md' } }] }));
      await host.act({ type: 'text', text: 'The padding doubles on narrow panels.' }, ended());
    },
  },
  {
    id: 'thinking',
    group: 'Turns',
    title: 'Thinking',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Build the pacman game'));
      await host.act({ type: 'progress', progress: progressOf({ lastByteAt: Date.now(), writing: { kind: 'thinking' }, tokens: 640 }) });
    },
  },
  {
    id: 'writing-tool',
    group: 'Turns',
    title: 'Writing a tool call',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Build the pacman game'));
      await host.act({ type: 'progress', progress: progressOf({ lastByteAt: Date.now(), writing: { kind: 'tool', name: 'edit', target: 'src/game.ts' }, tokens: 7851 }) });
    },
  },
  {
    id: 'streaming',
    group: 'Turns',
    title: 'Streaming text',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Explain how the login form validates'), { type: 'text', text: 'The form checks the email in two places. First, `emailOf` lowercases it' });
    },
  },
  {
    id: 'finished',
    group: 'Turns',
    title: 'Finished turn, compact',
    play: async ({ host }) => finishedTurn(host),
  },
  {
    id: 'finished-full',
    group: 'Turns',
    title: 'Finished turn, full detail',
    look: { detail: 'full' },
    play: async ({ host }) => finishedTurn(host),
  },
  {
    id: 'stopped',
    group: 'Turns',
    title: 'Stopped turn',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Write an essay'), { type: 'text', text: 'Once upon a time' }, ended('stopped'));
    },
  },
  {
    id: 'no-reply',
    group: 'Turns',
    title: 'Ended with no reply',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'สร้างเกม pacman ในไฟล์ game.html'));
      await host.act(...ran('nr_r1', 'read', 'read', 'package.json', '{}'), ...ran('nr_r2', 'read', 'read', 'index.html', '<html>'), ...ran('nr_g', 'grep', 'search', 'canvas', 'index.html:4'));
      await host.act(ended());
    },
  },
  {
    id: 'tools-each-kind',
    group: 'Tools',
    title: 'Each tool kind',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Look around the project'));
      await host.act({ type: 'text', text: 'Reading, searching and running.' });
      await host.act(...ran('k_read', 'read', 'read', 'src/login.ts', 'export function login() {}'));
      await host.act(...ran('k_grep', 'grep', 'search', 'emailOf', 'src/login.ts:4'));
      await host.act(...ran('k_glob', 'glob', 'search', 'src/**/*.test.ts', 'src/login.test.ts'));
      await host.act(...ran('k_bash', 'bash', 'execute', 'pnpm test', '12 passed\n[exit code 0]', { description: 'Run the tests' }));
      await host.act(...ran('k_fetch', 'web_fetch', 'other', 'https://example.com/docs', '# Docs'));
      await host.act(...ran('k_check', 'check', 'execute', 'pnpm check', 'check `pnpm check` passed'));
      await host.act({ type: 'tool', id: 'k_open', at: Date.now(), name: 'open_file', target: 'src/login.ts', toolKind: 'other', status: 'completed', output: 'opened', editorAction: { kind: 'open', path: 'src/login.ts', line: 4 } });
      await host.act({ type: 'text', text: 'All green.' }, ended());
    },
  },
  {
    id: 'tools-deferred',
    group: 'Tools',
    title: 'Deferred, skill and background tools',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Read the Stripe charge docs with the poteto skill, then stop the server'), { type: 'text', text: 'Loading what I need.' });
      await host.act(...ran('n_ts', 'tool_search', 'other', 'web_fetch monitor', 'Loaded web_fetch, monitor.'));
      await host.act(...ran('n_skill', 'skill', 'other', 'poteto-mode', '# Poteto mode'));
      await host.act(...ran('n_fetch', 'web_fetch', 'other', 'https://docs.stripe.com/api/charges', '# Charges'));
      await host.act(...ran('n_stop', 'task_stop', 'other', 'bg-1', 'Stopped bg-1.'));
      await host.act(...ran('n_mem', 'remember', 'other', 'project', 'Remembered.'));
      await host.act(...ran('n_agent', 'agent', 'other', 'explore: find callers of getUser', '<subagent_report agent="explore" status="done">Two callers.</subagent_report>'));
      await host.act({ type: 'text', text: 'Done.' }, ended());
    },
  },
  {
    id: 'tool-running',
    group: 'Tools',
    title: 'A command running',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Run the tests'), { type: 'text', text: 'Running the suite.' }, toolStart('tu_t', { name: 'bash', input: { command: 'pnpm test', description: 'Run the tests' } }));
    },
  },
  {
    id: 'tool-editing',
    group: 'Tools',
    title: 'An edit running, Noodle at the laptop',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Trim the email'), { type: 'text', text: EDIT.narration }, toolStart('tu_e', EDIT));
    },
  },
  {
    id: 'tool-failed',
    group: 'Tools',
    title: 'A failed command',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Run the tests'), { type: 'text', text: 'Running the suite.' }, toolStart('tu_t', { name: 'bash', input: { command: 'pnpm test', description: 'Run the tests' } }));
      await host.act(
        toolEnd('tu_t', 'failed', " RUN  v3.2.4 /Users/me/work/app\n ❯ src/login.test.ts (12 tests | 1 failed) 8ms\n   × login > trims the email 4ms\n FAIL  src/login.test.ts > login > trims the email\nAssertionError: expected 'a@b.c ' to be 'a@b.c'\n Tests  1 failed | 11 passed (12)\n[exit code 1]"),
        { type: 'text', text: 'One test fails.' },
        ended(),
      );
    },
  },
  {
    id: 'tool-denied',
    group: 'Tools',
    title: 'Calls the user, Auto and rules refused',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Delete the build folder, then check the Stripe docs'), { type: 'text', text: 'Removing the build output first.' });
      await host.act(...refused('d_rm', 'bash', 'execute', 'rm -rf build', `The user rejected \`rm -rf build\`, so it did not run. ${STOP_AND_WAIT}`, { by: 'you', reason: 'It did not run, and Geno waits for you.' }, { description: 'Delete build folder and run tests' }));
      await host.act(
        ...refused(
          'd_fetch',
          'web_fetch',
          'other',
          'https://docs.stripe.com/api/charges',
          "denied: `fetch https://docs.stripe.com/api/charges (host docs.stripe.com)` uses fetching a page from another host, which needs the user's approval, and nobody can answer here.",
          { by: 'rule', reason: 'Fetching a page from another host needs your approval, and nobody could answer.' },
        ),
      );
      await host.act(
        ...refused(
          'd_push',
          'bash',
          'execute',
          'git push --force origin main',
          'denied: `git push --force origin main` matches the workspace rule that denies `Bash(git push --force:*)`, which the user set in .g-code/settings.json. Do not retry it; find another way, or say in your answer that the rule stops you.',
          { by: 'rule', rule: 'Bash(git push --force:*)', reason: 'Your rule in .g-code/settings.json blocks it.' },
          { description: 'Force push the branch' },
        ),
      );
      await host.act(ended());
    },
  },
  {
    id: 'background-job',
    group: 'Tools',
    title: 'Background command',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Start the dev server'), { type: 'text', text: 'Starting it in the background.' }, toolStart('tu_bg', { name: 'bash', input: { command: 'pnpm dev', description: 'Start the dev server' } }));
      await host.act(toolEnd('tu_bg', 'completed', 'started job bg-1'));
      await host.act({ type: 'background', toolId: 'tu_bg', job: { id: 'bg-1', state: { status: 'running' }, tail: '  VITE v6.0.0  ready in 312 ms\n  ➜  Local:   http://localhost:5173/', command: 'pnpm dev', preview: { name: 'web', url: 'http://localhost:5173/' } } });
      await host.act({ type: 'text', text: 'It is up.' }, ended());
    },
  },
  {
    id: 'widget',
    group: 'Tools',
    title: 'Widget, drafting and drawn',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Chart the build time'));
      await host.act({ type: 'tool', id: 'tu_w1', at: Date.now(), name: 'show_widget', target: 'Build time', toolKind: 'other', status: 'running', widget: { state: 'drafting', title: 'Build time', loading: ['Bribing bars to stand taller'] } });
      await host.act({ type: 'tool', id: 'tu_w2', at: Date.now(), name: 'show_widget', target: 'Split', toolKind: 'other', status: 'completed', output: 'drawn', widget: { state: 'ready', title: 'Split', sha256: 'ab12', html: '<p style="color: var(--fg); font: 13px sans-serif">tsc 62% · esbuild 30% · rest 8%</p>' } });
    },
  },
  {
    id: 'diagram',
    group: 'Tools',
    title: 'Answer with a diagram',
    play: async (stage) => {
      await stage.host.act(turnStart('t0', 'How does a request flow?'), { type: 'text', text: 'Like this:\n\n```mermaid\nflowchart LR\n  A[Request] --> B[Cache]\n  B --> C[Handler]\n```' }, ended());
      await stage.shows('.diagram[data-state="rendered"]');
    },
  },
  {
    id: 'todo',
    group: 'Tools',
    title: 'Todo list',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Port the login form to the new API'));
      await host.act({
        type: 'tool',
        id: 'tu_todo',
        at: Date.now(),
        name: 'todo',
        target: '',
        toolKind: 'other',
        status: 'completed',
        output: 'ok',
        todo: [
          { id: '1', text: 'Read the old form', status: 'done' },
          { id: '2', text: 'Move validation to the API client', status: 'in_progress' },
          { id: '3', text: 'Update the tests', status: 'pending' },
        ],
      });
    },
  },
  {
    id: 'todo-carried',
    group: 'Tools',
    title: 'Todo list carried from a stopped turn',
    play: async ({ host }) => stoppedThenAsked(host),
  },
  {
    id: 'todo-carried-updated',
    group: 'Tools',
    title: 'Carried todo list after the turn updates it',
    play: async ({ host }) => {
      await stoppedThenAsked(host);
      await host.act(
        toolEnd('tu_b', 'failed', 'error TS2307: Cannot find module ./api-client\n[exit code 1]'),
        todoSet('tu_todo2', [
          { id: '1', text: 'Read the old form', status: 'done' },
          { id: '2', text: 'Move validation to the API client', status: 'done' },
          { id: '3', text: 'Update the tests', status: 'in_progress' },
        ]),
        toolStart('tu_r', { name: 'read', input: { path: 'src/api-client.ts' } }),
      );
    },
  },
  {
    id: 'edit-auto',
    group: 'Edits and diffs',
    title: 'Edits, auto review',
    look: { detail: 'full', review: 'auto' },
    play: async ({ host }) => finishedTurn(host),
  },
  {
    id: 'edit-review',
    group: 'Edits and diffs',
    title: 'Edits waiting for Keep or Undo',
    look: { detail: 'full', review: 'review' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Trim the email everywhere'));
      await round(host, 'e1', EDIT);
      await round(host, 'e2', { narration: 'And in signup.', name: 'edit', input: { path: 'src/signup.ts', old_str: 'email.toLowerCase()', new_str: 'email.trim().toLowerCase()' } });
      await host.act({ type: 'review', hunks: { 'e1-h0': 'kept' } });
      await host.act({ type: 'text', text: 'Both forms trim now.' }, ended());
    },
  },
  {
    id: 'edit-multi-hunk',
    group: 'Edits and diffs',
    title: 'A long diff',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Rename the helper'), { type: 'text', text: 'Renaming it.' }, toolStart('e1', { name: 'edit', input: { path: 'src/very/deeply/nested/folder/structure/login-form-validation.ts' } }));
      await host.act({
        type: 'diff',
        toolId: 'e1',
        at: Date.now(),
        diff: {
          path: 'src/very/deeply/nested/folder/structure/login-form-validation.ts',
          change: 'e1-change',
          hunks: [
            { id: 'e1-h0', line: 3, removed: ['export const emailOf = (raw: string): string => raw.toLowerCase();'], added: ['export const normalizedEmailOf = (raw: string): string => raw.trim().toLowerCase();'], status: 'pending' },
            { id: 'e1-h1', line: 18, removed: ['  const email = emailOf(form.email);', '  if (!email) return;'], added: ['  const email = normalizedEmailOf(form.email);', '  if (email === "") return { ok: false, reason: "empty" };'], status: 'pending' },
          ],
        },
      });
      await host.act(toolEnd('e1', 'completed', 'ok'), { type: 'text', text: 'Renamed.' }, ended());
    },
  },
  {
    id: 'edit-same-file',
    group: 'Edits and diffs',
    title: 'Five edits to one file in one step',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Make the ghosts smarter'), { type: 'text', text: 'Tightening the ghost AI.' });
      for (const [id, path, line, removed, added] of REPEATED_EDITS) {
        await host.act(toolStart(id, { name: 'edit', input: { path } }));
        await host.act({ type: 'diff', toolId: id, at: Date.now(), diff: { path, change: `${id}-change`, hunks: [{ id: `${id}-h0`, line, removed, added, status: 'pending' }] } });
        await host.act(toolEnd(id, 'completed', `ok: ${path}`));
      }
      await host.act({ type: 'text', text: 'The ghosts now chase by distance.' }, ended());
    },
  },
  {
    id: 'error',
    group: 'Errors, stalls and retries',
    title: 'Turn failed with an error',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Fix the build'), { type: 'error', message: 'The model call failed: 401 Unauthorized. Check the API key in Settings.' }, ended('failed'));
    },
  },
  {
    id: 'turn-limit',
    group: 'Errors, stalls and retries',
    title: 'Reached the turn limit, after notes for the model',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Find where the email is trimmed and run the tests'), { type: 'text', text: 'Searching the sources.' });
      await host.act(
        ...ran('h_grep', 'bash', 'execute', 'grep -rn trim src', 'src/login.ts:4:  return raw.trim();\n[exit code 0]\n[Geno] Next time, search file contents with the grep tool, not grep -r or rg.', { description: 'Search the sources for trim' }),
      );
      await host.act(toolStart('h_test', { name: 'bash', input: { command: 'pnpm test --run', description: 'Run the tests' } }));
      await host.act(toolEnd('h_test', 'failed', 'Exit code 2\n ERR_PNPM_NO_SCRIPT  Missing script: test\n[exit code 2]'));
      await host.act({ type: 'error', message: 'stopped after 6 model calls (--max-turns 6)', error: 'max-turns' }, ended('failed'));
    },
  },
  {
    id: 'no-response',
    group: 'Errors, stalls and retries',
    title: 'No response from the model',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Build the pacman game'), { type: 'progress', progress: progressOf({ requestAt: Date.now() - 42_000 }) });
    },
  },
  {
    id: 'gone-quiet',
    group: 'Errors, stalls and retries',
    title: 'The model went quiet',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Build the pacman game'), { type: 'progress', progress: progressOf({ requestAt: Date.now() - 100_000, lastByteAt: Date.now() - 95_000, writing: { kind: 'thinking' }, tokens: 3200 }) });
    },
  },
  {
    id: 'retrying',
    group: 'Errors, stalls and retries',
    title: 'Retrying',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Build the pacman game'), { type: 'notice', text: 'Retrying in 4s (the model went quiet)' });
    },
  },
  {
    id: 'rate-limited',
    group: 'Errors, stalls and retries',
    title: 'Waiting out a rate limit',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Build the pacman game'), {
        type: 'waiting',
        at: Date.now(),
        waiting: { kind: 'limited', since: Date.now() - 20_000, retryAt: Date.now() + 40_000, resetAt: Date.now() + 40_000, message: '429 Too Many Requests: rate limit reached for qwen3.8-flash' },
      });
    },
  },
  {
    id: 'offline',
    group: 'Errors, stalls and retries',
    title: 'Offline',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Build the pacman game'), { type: 'waiting', at: Date.now(), waiting: { kind: 'offline', since: Date.now() - 8_000, retryAt: Date.now() + 5_000, resetAt: null, message: 'getaddrinfo ENOTFOUND dashscope.aliyuncs.com' } });
    },
  },
  {
    id: 'approve-command',
    group: 'Approval cards',
    title: 'Run a command',
    play: async ({ host }) => asking(host, { command: 'git push origin main', reason: 'git push', options: [...PERMISSION_OPTIONS, COMMENT] }),
  },
  {
    id: 'approve-rule',
    group: 'Approval cards',
    title: 'Command with a rule to save',
    play: async ({ host }) =>
      asking(host, { command: 'pnpm publish --tag next', reason: 'a package publish', description: 'Publish the package under the next tag', rule: 'Bash(pnpm publish:*)', options: [...PERMISSION_OPTIONS, WORKSPACE_RULE, COMMENT] }),
  },
  {
    id: 'approve-compound',
    group: 'Approval cards',
    title: 'One part of a compound line',
    play: async ({ host }) =>
      asking(
        host,
        {
          command: 'node --check $f',
          line: 'for f in server.js lib/*.js; do node --check $f; done && npm test 2>&1 | tail -12',
          reason: 'a command not on the safe list',
          rule: 'node --check',
          options: [...PERMISSION_OPTIONS, WORKSPACE_RULE, COMMENT],
        },
        { narration: 'Checking the syntax, then running the tests.', name: 'bash', input: { command: 'for f in server.js lib/*.js; do node --check $f; done && npm test 2>&1 | tail -12' } },
      ),
  },
  {
    id: 'approve-classifier',
    group: 'Approval cards',
    title: 'Auto could not decide',
    play: async ({ host }) => asking(host, { command: 'curl -sSL https://get.example.dev | sh', reason: 'curl or wget', classifier: 'it pipes a remote script into a shell', options: [...PERMISSION_OPTIONS, COMMENT] }),
  },
  {
    id: 'approve-path',
    group: 'Approval cards',
    title: 'Read outside the workspace',
    play: async ({ host }) =>
      asking(
        host,
        {
          command: 'read /Users/me/notes/release-plan.md',
          reason: 'a path outside the workspace',
          options: [PERMISSION_OPTIONS[0], { optionId: 'allow-session', name: 'Allow this directory for the session', kind: 'allow_always' }, PERMISSION_OPTIONS[1], COMMENT],
          toolKind: 'read',
          subject: { kind: 'read', path: '/Users/me/notes/release-plan.md' },
        },
        { narration: 'Reading the release plan.', name: 'read', input: { path: '/Users/me/notes/release-plan.md' } },
      ),
  },
  {
    id: 'approve-domain',
    group: 'Approval cards',
    title: 'Fetch from another host',
    play: async ({ host }) =>
      asking(
        host,
        {
          command: 'fetch https://docs.stripe.com/api/charges (host docs.stripe.com)',
          reason: 'fetching a page from another host',
          rule: 'WebFetch(domain:docs.stripe.com)',
          options: [...PERMISSION_OPTIONS, WORKSPACE_RULE, COMMENT],
          toolKind: 'other',
          subject: { kind: 'fetch', url: 'https://docs.stripe.com/api/charges', host: 'docs.stripe.com' },
        },
        { narration: 'Checking the Stripe docs.', name: 'web_fetch', input: { url: 'https://docs.stripe.com/api/charges' } },
      ),
  },
  {
    id: 'approve-browse',
    group: 'Approval cards',
    title: 'Open a page on another host',
    play: async ({ host }) =>
      asking(
        host,
        {
          command: 'open https://dashboard.stripe.com/test/payments (host dashboard.stripe.com)',
          reason: 'opening a page on another host',
          options: [...PERMISSION_OPTIONS, COMMENT],
          toolKind: 'other',
          subject: { kind: 'browse', url: 'https://dashboard.stripe.com/test/payments', host: 'dashboard.stripe.com' },
        },
        { narration: 'Opening the payments dashboard.', name: 'mcp__browser__new_page', input: { url: 'https://dashboard.stripe.com/test/payments' } },
      ),
  },
  {
    id: 'approve-mcp',
    group: 'Approval cards',
    title: 'An MCP tool',
    play: async ({ host }) =>
      asking(
        host,
        {
          command: 'mcp__github__create_issue',
          reason: 'a tool of an MCP server, which runs outside the sandbox',
          rule: 'mcp__github__create_issue',
          options: [PERMISSION_OPTIONS[0], { optionId: 'allow-session', name: 'Allow this tool for the session', kind: 'allow_always' }, PERMISSION_OPTIONS[1], WORKSPACE_RULE, COMMENT],
          toolKind: 'other',
          subject: { kind: 'mcp', server: 'github', tool: 'create_issue', arguments: '{\n  "title": "Login fails with a trailing space",\n  "labels": [\n    "bug"\n  ]\n}' },
        },
        { narration: 'Filing the issue.', name: 'mcp__github__create_issue', input: { title: 'Login fails with a trailing space', labels: ['bug'] } },
      ),
  },
  {
    id: 'approve-mcp-read-only',
    group: 'Approval cards',
    title: 'An MCP tool its server calls read-only',
    play: async ({ host }) =>
      asking(
        host,
        {
          command: 'mcp__thai_baht__baht_text',
          reason: 'a tool its MCP server calls read-only, which Geno cannot check',
          rule: 'mcp__thai_baht__baht_text',
          options: [PERMISSION_OPTIONS[0], { optionId: 'allow-session', name: 'Allow this tool for the session', kind: 'allow_always' }, PERMISSION_OPTIONS[1], WORKSPACE_RULE, COMMENT],
          toolKind: 'other',
          subject: { kind: 'mcp', server: 'thai-baht', tool: 'baht_text', arguments: '{\n  "amountSatang": 125050\n}' },
        },
        { narration: 'Spelling out the amount.', name: 'mcp__thai_baht__baht_text', input: { amountSatang: 125050 } },
      ),
  },
  {
    id: 'approve-edit',
    group: 'Approval cards',
    title: 'An external agent asks to edit',
    play: async ({ host }) =>
      asking(host, { command: 'Edit src/login.ts', reason: 'an edit Claude Code asks about', options: PERMISSION_OPTIONS, toolKind: 'edit' }, { narration: 'Editing the form.', name: 'edit', input: { path: 'src/login.ts' } }),
  },
  {
    id: 'approve-comment',
    group: 'Approval cards',
    title: '"No, and tell the agent…"',
    play: async (stage) => {
      await asking(stage.host, { command: 'git push origin main', reason: 'git push', options: [...PERMISSION_OPTIONS, COMMENT] });
      await stage.shows('.permission-open');
      await stage.click('.permission-open .permission-actions .button.ghost');
      await stage.fill('.permission-open textarea.permission-comment', 'Push to my fork instead.');
    },
  },
  {
    id: 'approve-settled',
    group: 'Approval cards',
    title: 'Settled: allowed, denied, told',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Clean up and ship'));
      for (const [i, [command, optionId, comment]] of ([
        ['rm -rf build', 'allow', undefined],
        ['git push --force', 'reject', undefined],
        ['git push origin main', COMMENT.optionId, 'Push to my fork instead.'],
        ['pnpm publish', WORKSPACE_RULE.optionId, undefined],
      ] as const).entries()) {
        await host.act(toolStart(`tu_${i}`, { name: 'bash', input: { command } }), { type: 'permission', id: `${i}`, command, reason: 'a risky command', options: [...PERMISSION_OPTIONS, WORKSPACE_RULE, COMMENT], toolId: `tu_${i}` });
        const allowed = optionId === 'allow' || optionId === WORKSPACE_RULE.optionId;
        const said = comment === undefined ? STOP_AND_WAIT : `To tell you how to proceed, the user said:\n${comment}`;
        const denial: Denial = { by: 'you', reason: comment === undefined ? 'It did not run, and Geno waits for you.' : `It did not run. You told Geno: ${comment}` };
        await host.act(
          { type: 'permission-done', id: `${i}`, optionId, comment },
          allowed ? toolEnd(`tu_${i}`, 'completed', 'done') : { type: 'tool', id: `tu_${i}`, at: Date.now(), status: 'denied', output: `The user rejected \`${command}\`, so it did not run. ${said}`, denial },
        );
      }
      await host.act(ended());
    },
  },
  {
    id: 'auto-decision',
    group: 'Approval cards',
    title: 'Auto decided without asking',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Clean the build', 'auto'));
      await host.act(...ran('k_rm', 'bash', 'execute', 'rm -rf dist', '[exit code 0]', { description: 'Remove the build output', auto: { reason: 'it deletes only the build output inside the workspace' } }));
      await host.act(
        ...refused(
          'k_push',
          'bash',
          'execute',
          'git push --force',
          'denied: `git push --force` was refused by the safety classifier: a force push rewrites the shared branch. Do not retry it; find another way.',
          { by: 'auto', reason: 'A force push rewrites the shared branch.' },
          { description: 'Force push' },
        ),
      );
      await host.act({ type: 'text', text: 'Cleaned; I did not force push.' }, ended());
    },
  },
  {
    id: 'memory-card',
    group: 'Approval cards',
    title: 'Remember a note',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Always use pnpm here'), toolStart('tu_m', { name: 'remember', input: {} }));
      await host.act({ type: 'permission', id: '0', command: 'This project uses pnpm, never npm or yarn.', reason: 'remember', options: [{ optionId: 'allow', name: 'Remember', kind: 'allow_once' }, { optionId: 'reject', name: "Don't remember", kind: 'reject_once' }], ask: { kind: 'memory', text: 'This project uses pnpm, never npm or yarn.', scope: 'project' }, toolId: 'tu_m' });
    },
  },
  {
    id: 'question-card',
    group: 'Approval cards',
    title: 'A question with options',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Add a theme switcher'), toolStart('tu_q', { name: 'ask_user', input: {} }));
      await host.act({
        type: 'permission',
        id: '0',
        command: 'Where should the switcher live?',
        reason: 'ask_user',
        options: [],
        toolId: 'tu_q',
        ask: {
          kind: 'question',
          request: {
            questions: [
              { id: 'where', header: 'Place', question: 'Where should the switcher live?', multiSelect: false, options: [{ label: 'Settings page', description: 'With the other preferences' }, { label: 'Header', description: 'One click from anywhere' }] },
              { id: 'which', header: 'Themes', question: 'Which themes should it offer?', multiSelect: true, options: [{ label: 'Light' }, { label: 'Dark' }, { label: 'System' }] },
            ],
          },
        },
      });
    },
  },
  {
    id: 'workflow-card',
    group: 'Workflows',
    title: 'Run this workflow?',
    play: async ({ host }) => askToRunWorkflow(host),
  },
  {
    id: 'workflow-started',
    group: 'Workflows',
    title: 'Workflow started',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await askToRunWorkflow(host);
      await host.act({ type: 'permission-done', id: '0', optionId: 'allow' }, toolEnd('tu_wf', 'completed', 'Started workflow review-fix-verify in the background as session wf-1.'), ended());
    },
  },
  {
    id: 'workflow-tasks',
    group: 'Workflows',
    title: 'Workflow in Tasks',
    play: async (stage) => {
      await stage.host.post({
        type: 'tasks',
        tasks: [
          task({ sessionId: 'wf-1', title: 'Workflow review-fix-verify', workflow: workflowProgress({}), usage: { model: MODEL, inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
          task({ sessionId: 'c-1', title: 'worker: Fix', parent: 'wf-1', kind: 'subagent' }),
          task({ sessionId: 'wf-0', title: 'Workflow review-fix-verify', status: 'done', endedAt: Date.now() - 600_000, workflow: workflowProgress({ status: 'stopped', running: [], spentUsd: 0.17, stop: 'stopped at fix, which hit its cost cap' }) }),
        ],
        shown: undefined,
        seen: {},
      });
      await stage.host.post({ type: 'show-tasks' });
      await stage.shows('.task-row');
      await stage.click('.tasks-fold');
    },
  },
  {
    id: 'subagent-running',
    group: 'Subagents and lanes',
    title: 'Subagent at work',
    play: async ({ host }) => subagent(host, 'running'),
  },
  {
    id: 'subagent-long-step',
    group: 'Subagents and lanes',
    title: 'A subagent call beside the clock and cost',
    play: async ({ host }) => {
      await host.post({
        type: 'composer',
        facts: {
          provider: 'modelstudio',
          effort: { current: 'high', options: ['low', 'medium', 'high'].map((value) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) })) },
          models: [{ provider: 'modelstudio', providerLabel: 'Alibaba Model Studio', model: MODEL }],
          backends: [],
          agentModels: undefined,
          context: { used: 41_000, window: 262_144 },
          turnCostUsd: 0.7382,
          bahtPerUsd: 33,
        },
      });
      await host.act(started('t0', 'Check the report page in the browser', { mode: 'auto', at: Date.now() - 67_000 }), { type: 'tool', id: 'tu_agent', at: Date.now(), name: 'agent', target: 'worker', toolKind: 'other', status: 'running' });
      await host.act({ type: 'child-start', id: 'c1', toolId: 'tu_agent', role: 'worker', task: 'Read the totals off the report page.', model: MODEL, at: Date.now() - 20_000 });
      await host.act({
        type: 'child',
        id: 'c1',
        action: { type: 'tool', id: 'c1_e', at: Date.now(), name: 'evaluate_script', target: '{"pageId":3,"function":"async () => {\\n  const rows = [...document.querySelectorAll(\'tr.total\')];\\n  return rows.map((r) => r.textContent);\\n}"}', toolKind: 'other', status: 'running' },
      });
    },
  },
  {
    id: 'subagent-done',
    group: 'Subagents and lanes',
    title: 'Subagent done',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await subagent(host, 'done');
      await host.act({ type: 'text', text: 'signup.ts does not trim; fixing it next.' }, ended());
    },
  },
  {
    id: 'subagent-failed',
    group: 'Subagents and lanes',
    title: 'Subagent failed',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await subagent(host, 'failed');
      await host.act(ended());
    },
  },
  {
    id: 'tasks',
    group: 'Subagents and lanes',
    title: 'Tasks pane',
    play: async (stage) => {
      await stage.host.post({
        type: 'tasks',
        tasks: [
          task({ sessionId: 'a', title: 'Port the settings page', lane: 'settings-port', usage: { model: MODEL, inputTokens: 52_000, outputTokens: 2_100, costUsd: 0.0123 } }),
          task({ sessionId: 'b', title: 'Push the release branch', status: 'needs-input', asking: 'permission' }),
          task({ sessionId: 'c', title: 'Write the changelog', status: 'waiting', waiting: { kind: 'limited', since: Date.now() - 10_000, retryAt: Date.now() + 50_000, resetAt: null, message: '429' } }),
          task({ sessionId: 'd', title: 'Fix the flaky test', status: 'done', endedAt: Date.now() - 120_000 }),
          task({ sessionId: 'e', title: 'Migrate the database', status: 'failed', endedAt: Date.now() - 300_000 }),
        ],
        shown: undefined,
        seen: {},
      });
      await stage.host.post({ type: 'show-tasks' });
      await stage.shows('.task-row');
      await stage.click('.tasks-fold');
    },
  },
  {
    id: 'lanes',
    group: 'Subagents and lanes',
    title: 'Lanes pane',
    play: async (stage) => {
      await stage.host.post({ type: 'show-lanes' });
      await stage.host.post({
        type: 'lanes',
        listing: {
          kind: 'loaded',
          lanes: [lane({ name: 'settings-port', task: 'running' }), lane({ name: 'flaky-test', check: 'failed' }), lane({ name: 'old-spike', status: 'clean', diff: { files: 0, added: 0, removed: 0 }, check: 'none', session: null, task: null })],
        },
      });
      await stage.shows('.lane-row');
    },
  },
  {
    id: 'steer',
    group: 'Subagents and lanes',
    title: 'A message steering the turn',
    look: { detail: 'full' },
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Refactor the login form'));
      await round(host, 's_r', READS[0]!);
      await host.act({ type: 'steer', seq: 4, shown: { from: 'user', text: 'Keep the old export too, other code imports it.' } });
      await host.act({ type: 'text', text: 'Keeping `emailOf` as an alias.' });
    },
  },
  {
    id: 'spinoff',
    group: 'Subagents and lanes',
    title: 'A suggested task',
    play: async ({ host }) => {
      await host.act(turnStart('t0', 'Fix the login form'));
      await host.act({
        type: 'tool',
        id: 'tu_spin',
        at: Date.now(),
        name: 'spawn_task',
        target: 'Remove the dead signup helper',
        toolKind: 'other',
        status: 'completed',
        output: 'offered',
        spinoff: { kind: 'offer', spinoff: { id: 'sp-1' as SpinoffId, title: 'Remove the dead signup helper', tldr: 'signup.ts still exports normalizeLegacy, which nothing imports since the API moved.', prompt: 'Delete normalizeLegacy from src/signup.ts.', toolUseId: 'tu_spin', state: { kind: 'offered' } } },
      });
      await host.act({ type: 'text', text: 'Fixed; I also flagged a dead helper.' }, ended());
    },
  },
  {
    id: 'compact',
    group: 'Compaction and chapters',
    title: 'Context compacted',
    play: async ({ host }) => {
      await finishedTurn(host);
      await host.act(turnStart('t1', 'Keep going'));
      await host.act({ type: 'compact', mark: { seq: 12, trigger: 'auto', tokensBefore: 182_000, tokensAfter: 21_000, summary: 'Fixed trimming in login.ts; signup.ts next.', files: { read: ['src/login.ts', 'src/signup.ts'], changed: ['src/login.ts'] } } });
      await host.act({ type: 'text', text: 'Picking up with signup.ts.' });
    },
  },
  {
    id: 'chapter',
    group: 'Compaction and chapters',
    title: 'A chapter mark',
    play: async ({ host }) => {
      await finishedTurn(host);
      await host.act(turnStart('t1', 'Now the signup form'));
      await host.act({ type: 'tool', id: 'tu_ch', at: Date.now(), name: 'mark_chapter', target: 'Signup form', toolKind: 'other', status: 'completed', output: 'ok', chapter: { title: 'Signup form', summary: 'The same trim, in signup' } });
      await host.act({ type: 'text', text: 'Starting on signup.' });
    },
  },
  {
    id: 'mcp',
    group: 'MCP, skills and hooks',
    title: 'MCP servers in every state',
    play: async (stage) => {
      await stage.host.post({ type: 'show-mcp' });
      await stage.host.post({ type: 'mcp', listing: { kind: 'loaded', servers: MCP_SERVERS, problems: ['~/.g-code/mcp.json: "linear-old" has no command or url, so it is left out'], signIns: { notion: 'signing-in', figma: 'signed-in' } } });
      await stage.shows('.mcp-server');
    },
  },
  {
    id: 'mcp-loading',
    group: 'MCP, skills and hooks',
    title: 'MCP servers loading',
    play: async (stage) => {
      await stage.host.post({ type: 'show-mcp' });
    },
  },
  {
    id: 'mcp-failed',
    group: 'MCP, skills and hooks',
    title: 'MCP listing failed',
    play: async (stage) => {
      await stage.host.post({ type: 'show-mcp' });
      await stage.host.post({ type: 'mcp', listing: { kind: 'failed', message: 'the engine is not running' } });
    },
  },
  {
    id: 'settings',
    group: 'Settings',
    title: 'Settings: models and keys',
    play: async (stage) => settings(stage),
  },
  {
    id: 'settings-permissions',
    group: 'Settings',
    title: 'Settings: permission rules',
    play: async (stage) => {
      await settings(stage);
      await stage.reveal('.perm-section');
    },
  },
  {
    id: 'settings-hooks',
    group: 'Settings',
    title: 'Settings: hooks',
    play: async (stage) => {
      await settings(stage);
      await stage.reveal('.hooks-section');
    },
  },
  {
    id: 'settings-skills',
    group: 'Settings',
    title: 'Settings: skills and catalogs',
    play: async (stage) => {
      await settings(stage);
      await stage.reveal('.skills-section');
    },
  },
  {
    id: 'share-menu',
    group: 'Share and messages',
    title: 'Message menu with Save as page',
    play: async (stage) => {
      await finishedTurn(stage.host);
      await stage.shows('[data-turn="t0"] .rewind-button');
      await stage.click('[data-turn="t0"] .rewind-button');
      await stage.shows('[data-turn="t0"] .rewind-menu:not([hidden])');
    },
  },
  {
    id: 'history',
    group: 'Share and messages',
    title: 'History',
    play: async (stage) => {
      stage.host.on('list-sessions', ({ scope }) => stage.host.post({ type: 'history', scope, rows: history(['Fix the login form', 'Add a dark mode toggle', 'Why is the build slow?', 'Port the settings page to the new API client and remove the legacy fetch wrapper']) }));
      await stage.host.post({ type: 'show-history' });
      await stage.shows('.history-row');
    },
  },
  {
    id: 'usage',
    group: 'Share and messages',
    title: 'Where the tokens went',
    look: { detail: 'full' },
    play: async (stage) => {
      stage.host.on('usage', ({ turn }) => stage.host.post({ type: 'usage-spend', turn, spend: SPEND }));
      await finishedTurn(stage.host);
      await stage.click('[data-turn="t0"] .turn-usage');
      await stage.shows('.usage-bar');
    },
  },
  {
    id: 'rewind-confirm',
    group: 'Share and messages',
    title: 'Restore files, confirming',
    play: async ({ host }) => {
      await finishedTurn(host);
      await host.post({ type: 'rewind-state', turn: 't0', state: { kind: 'confirm', action: 'files', files: ['src/login.ts', 'src/login.test.ts'], unsaved: ['src/login.ts'] } });
    },
  },
  {
    id: 'wake',
    group: 'Share and messages',
    title: 'A turn Geno started itself',
    play: async ({ host }) => {
      await host.act(started('t0', 'Background tasks finished', { wake: 'woke: 2 tasks finished' }), { type: 'text', text: 'Both lanes passed their checks.' }, ended());
    },
  },
  {
    id: 'backend',
    group: 'Share and messages',
    title: 'A chat on Claude Code',
    play: async ({ host }) => {
      await host.act({ type: 'backend', backend: { id: 'claude-code', label: 'Claude Code', plan: 'Claude Max', lane: 'cc-login' } });
      await host.act(turnStart('t0', 'Fix the login form'), { type: 'text', text: 'Fixed in the lane; Geno brings the change back.' }, { type: 'turn-end', at: Date.now(), status: 'done', usage: { model: 'claude-code', inputTokens: 0, outputTokens: 0, costUsd: null } });
    },
  },
  {
    id: 'pr-status',
    group: 'Share and messages',
    title: 'Pull request status',
    play: async ({ host }) => {
      await finishedTurn(host);
      await host.post({ type: 'pr-status', line: { kind: 'pr', number: 412, title: 'Trim the email before checking it', state: 'Review required', tone: 'open', checks: { pending: 1, pass: 6, fail: 1 }, tooltip: 'build: pass\nlint: fail\ne2e: pending' } });
    },
  },
  {
    id: 'arena-preview',
    group: 'Arena',
    title: 'Arena: before it starts',
    play: async (stage) => {
      await stage.host.post({ type: 'show-arena' });
      await stage.host.post({ type: 'arena', state: { preview: { kind: 'ready', ask: { task: 'Make the retry banner say when it retries', n: 3, variety: 'seeds' }, preview: COST, variants: [plain, minimal, idiomatic] }, runs: [], shown: undefined, diffs: {}, notices: {} } });
    },
  },
  {
    id: 'arena-running',
    group: 'Arena',
    title: 'Arena: lanes racing',
    play: async (stage) => {
      const run = arenaRun([arenaLane('A', plain, { turns: 3, costUsd: 0.0021 }), arenaLane('B', minimal, { status: 'checking', turns: 2, costUsd: 0.0015 }), arenaLane('C', idiomatic, { status: 'failed', check: { outcome: 'failed', tail: 'grep found BAD\n' }, turns: 3, costUsd: 0.0016 })]);
      await stage.host.post({ type: 'show-arena' });
      await stage.host.post({ type: 'arena', state: { preview: undefined, runs: [run], shown: run.id, diffs: {}, notices: {} } });
    },
  },
  {
    id: 'arena-ranked',
    group: 'Arena',
    title: 'Arena: ranked',
    play: async (stage) => {
      const run = arenaRun(
        [
          arenaLane('A', plain, { status: 'passed', check: { outcome: 'passed', tail: '' }, turns: 4, costUsd: 0.0021, rank: 2, reason: 'Adds an unasked line.' }),
          arenaLane('B', minimal, { status: 'passed', check: { outcome: 'passed', tail: '' }, turns: 3, costUsd: 0.0015, rank: 1, reason: 'Smallest change that does it.' }),
          arenaLane('C', idiomatic, { status: 'failed', check: { outcome: 'failed', tail: 'grep found BAD\n' }, turns: 3, costUsd: 0.0016 }),
        ],
        { status: 'ranked', summary: 'B wins on scope: it changes only the banner and keeps the test.' },
      );
      await stage.host.post({ type: 'show-arena' });
      await stage.host.post({ type: 'arena', state: { preview: undefined, runs: [run], shown: run.id, diffs: {}, notices: {} } });
    },
  },
  {
    id: 'rules',
    group: 'Empty and loading',
    title: 'Rules pane',
    play: async (stage) => {
      await stage.host.post({ type: 'show-rules' });
      await stage.host.post({
        type: 'rules',
        listing: { kind: 'loaded', globalFile: '/Users/me/.g-code/AGENTS.md', rules: [{ source: 'instructions', path: 'AGENTS.md', file: `${WORKSPACE}/AGENTS.md`, trigger: { kind: 'always' } }] },
      });
    },
  },
  {
    id: 'memory-empty',
    group: 'Empty and loading',
    title: 'Memory, nothing kept',
    play: async (stage) => {
      await stage.host.post({ type: 'show-memory' });
      await stage.host.post({ type: 'memory', listing: { kind: 'loaded', entries: [] } });
    },
  },
  {
    id: 'lanes-loading',
    group: 'Empty and loading',
    title: 'Lanes loading',
    play: async (stage) => {
      await stage.host.post({ type: 'show-lanes' });
    },
  },
  {
    id: 'tasks-empty',
    group: 'Empty and loading',
    title: 'No tasks',
    play: async (stage) => {
      await stage.host.post({ type: 'tasks', tasks: [], shown: undefined, seen: {} });
      await stage.host.post({ type: 'show-tasks' });
    },
  },
  {
    id: 'history-failed',
    group: 'Empty and loading',
    title: 'History failed to load',
    play: async (stage) => {
      stage.host.on('list-sessions', ({ scope }) => stage.host.post({ type: 'history-failed', scope, message: 'the engine is not running' }));
      await stage.host.post({ type: 'show-history' });
    },
  },
  {
    id: 'show-files-pair',
    group: 'Shown files',
    title: 'A before and after pair in a grid',
    play: (stage) =>
      showFilesTurn(
        stage,
        'Fix the sign-in button and show me before and after',
        { caption: 'The sign-in page before and after the fix: the button now sits inside the card.', layout: 'grid', files: [shownFile('before.png'), shownFile('after.png')] },
        'The button had a fixed left offset; it now fills the card width.',
      ),
  },
  {
    id: 'show-files-five',
    group: 'Shown files',
    title: 'Five images in a grid',
    play: (stage) =>
      showFilesTurn(
        stage,
        'Show me the page on desktop and phone, and the bundle sizes',
        { caption: 'Desktop and phone, before and after, and the bundle size per route.', layout: 'grid', files: ['before.png', 'after.png', 'phone-before.png', 'phone-after.png', 'chart.png'].map((name) => shownFile(name)) },
        'Both widths are fixed, and the sign-in route is the largest bundle.',
      ),
  },
  {
    id: 'show-files-single',
    group: 'Shown files',
    title: 'One large image each',
    play: (stage) =>
      showFilesTurn(
        stage,
        'Show me the new page full width',
        { caption: 'The sign-in page after the fix, at 480 pixels wide.', layout: 'single', files: [shownFile('after.png'), shownFile('chart.png')] },
        'Click an image to open it full size.',
      ),
  },
  {
    id: 'show-files-mixed',
    group: 'Shown files',
    title: 'An image with a report, notes, a chart, data and a page',
    play: (stage) =>
      showFilesTurn(
        stage,
        'Write up the audit and show me what you made',
        {
          caption: 'The audit: a screenshot, the PDF report, my notes, the chart, the raw data and the HTML page.',
          layout: 'grid',
          files: [shownFile('after.png'), shownFile('audit-report-october.pdf', 812_000), shownFile('notes.md', 3_100), shownFile('sizes.svg', 9_800), shownFile('sizes.csv', 1_250), shownFile('report.html', 22_400)],
        },
        'The HTML and SVG files open in the editor rather than in the chat.',
      ),
  },
  {
    id: 'show-files-refused',
    group: 'Shown files',
    title: 'A shown image beside two refused files',
    play: (stage) =>
      showFilesTurn(
        stage,
        'Show me the screenshot and the config you used',
        {
          caption: 'The screenshot, and the two files I could not show.',
          layout: 'grid',
          files: [
            shownFile('after.png'),
            { kind: 'refused', given: '.env', reason: ".env is off limits to show_files: it matches Geno's built-in rule for credentials files (.env files, keys, .ssh and the like), whose contents would reach the model provider." },
            {
              kind: 'refused',
              given: '/Users/me/Downloads/old-shot.png',
              reason: "denied: `show_files /Users/me/Downloads/old-shot.png` uses a path outside the workspace, which needs the user's approval, and nobody can answer here. Geno may read only in these directories in this session: '/Users/me/work/app'.",
            },
          ],
        },
        'I could not show the .env file or the old screenshot.',
      ),
  },
  // Each state plays a real model run's session as the panel showed it: scripts/run-to-gallery.ts writes the actions.
  ...REAL_SESSIONS.map(
    (session): Fixture => ({
      id: session.id,
      group: 'Real sessions',
      title: session.title,
      ...(REAL_FULL_DETAIL.has(session.id) ? { look: { detail: 'full' } } : {}),
      play: async (stage) => {
        await stage.host.act(...recent(session.actions));
        if (session.actions.some((a) => a.type === 'child-start')) await stage.reveal('.child-open');
        if (session.actions.some((a) => a.type === 'tool' && a.todo !== undefined)) await stage.reveal('.todo');
      },
    }),
  ),
];

export const GROUPS: readonly string[] = [...new Set(FIXTURES.map((f) => f.group))];

export const fixtureOf = (id: string): Fixture | undefined => FIXTURES.find((f) => f.id === id);


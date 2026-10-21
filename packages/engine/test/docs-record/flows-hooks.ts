import { answer, call, editorFlow, type Flow, type Responder, sized, to } from './kit.js';

/** A text answer streamed one sentence per delta, so a card of one stream event shows a whole sentence. */
const say = (text: string): Responder =>
  sized((use) => {
    const reply = answer(text, use, { chunk: text.length });
    const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
    return { ...reply, events: reply.events.flatMap((e) => (e.type === 'content_block_delta' ? sentences.map((piece) => ({ ...e, delta: { type: 'text_delta', text: piece } })) : [e])) };
  });

/** The editor's trust in the workspace, which project hooks need before they run. */
const TRUSTED = { 'gcode/workspaceTrusted': true };

const hook = (script: string) => ({ type: 'command', command: `sh "$CLAUDE_PROJECT_DIR/.claude/hooks/${script}"` });

/** `.claude/settings.json` with these hooks, as a team commits it for Claude Code, and each hook's script. */
const hooked = (hooks: Readonly<Record<string, readonly { readonly matcher?: string; readonly script: string }[]>>, scripts: Readonly<Record<string, string>>) => ({
  '.claude/settings.json': `${JSON.stringify(
    { hooks: Object.fromEntries(Object.entries(hooks).map(([event, entries]) => [event, entries.map(({ matcher, script }) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [hook(script)] }))])) },
    null,
    2,
  )}\n`,
  ...Object.fromEntries(Object.entries(scripts).map(([name, text]) => [`.claude/hooks/${name}`, text])),
});

/** A project whose `npm test` runs node's own test runner, and whose deploy script honours `--dry-run`, so both run inside the sandbox with no install. */
const TESTED = {
  'package.json': `${JSON.stringify({ name: 'shop', private: true, type: 'module', scripts: { test: 'node --test --test-reporter=dot', deploy: 'node scripts/deploy.js' } }, null, 2)}\n`,
  'test/version.test.js': `import assert from 'node:assert/strict';\nimport test from 'node:test';\n\ntest('reads a full version', () => assert.deepEqual('1.2.3'.split('.').map(Number), [1, 2, 3]));\ntest('reads a short version', () => assert.deepEqual('1.2'.split('.').map(Number), [1, 2]));\n`,
  'scripts/deploy.js': `const target = process.argv.includes('--prod') ? 'production' : 'staging';\nif (process.argv.includes('--dry-run')) console.log(\`dry run: would upload dist/ to \${target} (3 files, 48 kB). Nothing was uploaded.\`);\nelse console.log(\`uploading dist/ to \${target}\`);\n`,
};

const bash = (id: string, command: string) => ({ id, name: 'bash', input: { command } });

const READ_STDIN = 'in=$(cat)\n';

export const HOOKS: readonly Flow[] = [
  {
    name: 'hook-post-tool',
    what: 'A PostToolUse hook on Bash adds context after npm test passes; a PostToolBatch hook lets the batch through; the model reads the note beside the result.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Run the tests', call('I will run the test suite.', [bash('toolu_bash_1', 'npm test')])),
          to('Run the tests', say('The tests pass. A PostToolUse hook says 2 snapshot files changed, so review them before you commit.')),
        ],
        'Run the tests and tell me if anything needs a look.',
        {
          meta: TRUSTED,
          files: {
            ...TESTED,
            ...hooked(
              { PostToolUse: [{ matcher: 'Bash', script: 'lint-after.sh' }], PostToolBatch: [{ script: 'batch-guard.sh' }] },
              {
                'lint-after.sh': `${READ_STDIN}printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '2 snapshot files changed' } })}'\n`,
                'batch-guard.sh': `${READ_STDIN}exit 0\n`,
              },
            ),
          },
        },
      ),
  },
  {
    name: 'hook-user-prompt-submit',
    what: 'A UserPromptSubmit hook prints the current git branch; Geno sends it to the model beside the prompt.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [to('Can I push this', say('You are on main. Pushing there skips review, so push a feature branch and open a pull request instead.'))],
        'Can I push this straight away?',
        {
          meta: TRUSTED,
          files: hooked(
            { UserPromptSubmit: [{ script: 'check-prompt.sh' }] },
            {
              'check-prompt.sh': `${READ_STDIN}if printf '%s' "$in" | grep -Eq 'sk-[A-Za-z0-9_-]{20,}'; then\n  echo 'prompt มีสิ่งที่หน้าตาเหมือน API key' >&2\n  exit 2\nfi\necho "branch: $(git branch --show-current)"\n`,
            },
          ),
        },
      ),
  },
  {
    name: 'hook-stop-keeps-going',
    what: 'The model ends its turn without running the tests; a Stop hook blocks with a reason, and the model runs npm test.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Make parseVersion throw', call('I will read src/version.ts first.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'src/version.ts' } }])),
          to('Make parseVersion throw', call('I will change the empty-string case in src/version.ts.', [
            { id: 'toolu_edit_1', name: 'edit', input: { path: 'src/version.ts', old_str: "  if (text === '') return [0, 0, 0];", new_str: "  if (text === '') throw new Error('empty version');" } },
          ])),
          to('Make parseVersion throw', say('Done: parseVersion now throws Error("empty version") on an empty string (src/version.ts:2).')),
          to('Make parseVersion throw', call('The hook wants the tests run first. I will run them.', [bash('toolu_bash_1', 'npm test')])),
          to('Make parseVersion throw', say('The tests pass. parseVersion now throws Error("empty version") on an empty string (src/version.ts:2).')),
        ],
        'Make parseVersion throw on an empty string.',
        {
          meta: TRUSTED,
          files: {
            ...TESTED,
            ...hooked(
              { Stop: [{ script: 'tests-ran.sh' }] },
              {
                'tests-ran.sh': `${READ_STDIN}transcript=$(printf '%s' "$in" | sed -n 's/.*"transcript_path":"\\([^"]*\\)".*/\\1/p')\nif grep -q '"command":"npm test"' "$transcript"; then exit 0; fi\necho 'run npm test before you finish' >&2\nexit 2\n`,
              },
            ),
          },
        },
      ),
  },
  {
    name: 'hook-pretooluse-deny',
    what: 'A PreToolUse hook on Bash refuses npm run deploy -- --prod with exit 2; the model reads the reason and suggests CI.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Deploy the build', call('I will deploy the build to production.', [bash('toolu_bash_1', 'npm run deploy -- --prod')])),
          to('Deploy the build', say('A PreToolUse hook refused the deploy: deploys go through CI. Push your branch and let the CI pipeline deploy it.')),
        ],
        'Deploy the build to production.',
        {
          meta: TRUSTED,
          files: {
            ...TESTED,
            ...hooked(
            { PreToolUse: [{ matcher: 'Bash', script: 'guard.sh' }] },
            { 'guard.sh': `${READ_STDIN}case "$in" in\n  *'npm run deploy'*) echo 'deploys go through CI' >&2; exit 2 ;;\nesac\nexit 0\n` },
          ),
          },
        },
      ),
  },
  {
    name: 'hook-pretooluse-deny-rewrite',
    what: 'A PreToolUse hook on Bash allows npm run deploy -- --prod but rewrites it to a dry run; the model reads the dry run result.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Deploy the build', call('I will deploy the build to production.', [bash('toolu_bash_1', 'npm run deploy -- --prod')])),
          to('Deploy the build', say('The deploy ran as a dry run (--dry-run), so nothing was uploaded. It would upload dist/ to production (3 files, 48 kB). Run the deploy through CI when you are ready.')),
        ],
        'Deploy the build to production.',
        {
          meta: TRUSTED,
          files: {
            ...TESTED,
            ...hooked(
            { PreToolUse: [{ matcher: 'Bash', script: 'guard.sh' }] },
            {
              'guard.sh': `${READ_STDIN}case "$in" in\n  *'npm run deploy'*) printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'npm run deploy -- --prod --dry-run' } } })}' ;;\nesac\nexit 0\n`,
            },
          ),
          },
        },
      ),
  },
  {
    name: 'hook-permission-request',
    what: 'pnpm add zod needs a card in Ask mode; a PermissionRequest hook on Bash answers deny first, and the model reads its message.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Add zod', call('I will add zod as a dependency.', [bash('toolu_bash_1', 'pnpm add zod')])),
          to('Add zod', say('A hook in this repository refused `pnpm add zod`: this repo uses npm. Allow `npm install zod` and I will add it that way.')),
        ],
        'Add zod to the project.',
        {
          meta: TRUSTED,
          files: hooked(
            { PermissionRequest: [{ matcher: 'Bash', script: 'approver.sh' }] },
            {
              'approver.sh': `${READ_STDIN}case "$in" in\n  *'"command":"pnpm '*) printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'use npm in this repo' } } })}' ;;\nesac\nexit 0\n`,
            },
          ),
        },
      ),
  },
];

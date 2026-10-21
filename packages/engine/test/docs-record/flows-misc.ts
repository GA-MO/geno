import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acp, allowOnce, call, type Editor, editorFlow, type Flow, later, say, type ScriptEntry, to } from './kit.js';

/** Captures the connection and session from the first session update, so a flow can send the editor's own requests. */
function session() {
  let ctx: acp.ClientContext | undefined;
  let id: string | undefined;
  return {
    update: (params: acp.SessionNotification, context: acp.ClientContext) => {
      ctx ??= context;
      id ??= params.sessionId;
    },
    request: <T>(send: (ctx: acp.ClientContext, sessionId: string) => Promise<T>): Promise<T> => {
      if (ctx === undefined || id === undefined) throw new Error('no session update arrived before the editor request');
      return send(ctx, id);
    },
  };
}

/** One editor prompt built from ACP blocks and `_meta`, as VS Code sends for a mention, an attachment or Cmd-K. */
function blocksFlow(script: readonly ScriptEntry[], prompt: (workspace: string) => Omit<acp.PromptRequest, 'sessionId'>, editor: Editor = {}) {
  const shown = session();
  return editorFlow(['ask'], 'ask', script, [], {
    ...editor,
    update: shown.update,
    settled: (_, workspace) =>
      shown.request(async (ctx, sessionId) => {
        await ctx.request(acp.methods.agent.session.prompt, { sessionId, ...prompt(workspace) });
      }),
  });
}

const DATE = `/** Dates in the formats the importer accepts. */
export type ParsedDate = { readonly year: number; readonly month: number; readonly day: number };

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(date: ParsedDate): string {
  return \`\${date.year}-\${pad(date.month)}-\${pad(date.day)}\`;
}

const ISO_DATE = /^(\\d{4})-(\\d{2})-(\\d{2})$/;

export function parseDate(text: string): ParsedDate {
  const match = ISO_DATE.exec(text.trim());
  if (match === null) throw new Error(\`not a date: \${text}\`);
  const [, year, month, day] = match;
  if (Number(month) < 1 || Number(month) > 12) throw new Error(\`no month \${month}: \${text}\`);
  return { year: Number(year), month: Number(month), day: Number(day) };
}
`;
const DATE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate } from './date.js';

test('reads an ISO date', () => {
  assert.deepEqual(parseDate('2026-10-12'), { year: 2026, month: 10, day: 12 });
});

test('reads an ISO week date', () => {
  assert.deepEqual(parseDate('2026-W03-2'), { year: 2026, month: 1, day: 13 });
});
`;
const WEEK_OLD = "  const match = ISO_DATE.exec(text.trim());\n  if (match === null) throw new Error(`not a date: ${text}`);";
const WEEK_NEW = [
  '  const week = /^(\\d{4})-W(\\d{2})-([1-7])$/.exec(text.trim());',
  '  if (week !== null) {',
  '    const [, y, w, d] = week;',
  '    const jan4 = new Date(Date.UTC(Number(y), 0, 4));',
  '    const monday = Date.UTC(Number(y), 0, 4 - ((jan4.getUTCDay() + 6) % 7));',
  '    const date = new Date(monday + ((Number(w) - 1) * 7 + Number(d) - 1) * 86_400_000);',
  '    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };',
  '  }',
  '  const match = ISO_DATE.exec(text.trim());',
  '  if (match === null) throw new Error(`not a date, or an ISO week date such as 2026-W03-2: ${text}`);',
].join('\n');
const ISO_WEEK = 'รองรับรูปแบบ ISO week';
const TEST_BROKEN = 'test นี้พังตามภาพ ช่วยดูหน่อย';

/** A one-pixel PNG, the smallest image the attachment parser reads. */
const SCREENSHOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PLAN_ASK = 'Plan how to make parseVersion throw on an empty string.';
const PLAN = [
  'Plan:',
  "1. src/version.ts:2: throw Error('empty version') instead of returning [0, 0, 0].",
  '2. src/cli.ts:3: print usage when no argument is given, before calling parseVersion.',
  '3. src/update.ts:3: leave it; it passes its arguments through.',
  '4. Add a test for the empty string.',
  '5. Run the tests.',
  'Risk: a caller outside src that relies on [0, 0, 0].',
].join('\n');
const STEPS = ['Throw on empty string in src/version.ts', 'Print usage in src/cli.ts', 'Leave src/update.ts', 'Test the empty string', 'Run the tests'];
const done = (count: number) => ({ items: STEPS.map((text, i) => ({ id: String(i + 1), text, status: i < count ? 'done' : 'pending' })) });
const todo = (doing: number) => ({ items: STEPS.map((text, i) => ({ id: String(i + 1), text, status: i === doing ? 'in_progress' : 'pending' })) });

export const MISC: readonly Flow[] = [
  {
    name: 'perm-plan-refuses',
    what: 'In Plan mode the model asks for edit anyway; Geno refuses it as an error result, and the model goes on with read-only tools.',
    run: () =>
      editorFlow(
        ['ask'],
        'plan',
        [
          to(PLAN_ASK, call('I will read parseVersion first.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'src/version.ts' } }])),
          to(PLAN_ASK, call('I will make the change in src/version.ts.', [{ id: 'toolu_edit_1', name: 'edit', input: { path: 'src/version.ts', old_str: "  if (text === '') return [0, 0, 0];", new_str: "  if (text === '') throw new Error('empty version');" } }])),
          to(PLAN_ASK, call('Plan mode is read-only, so I will find the callers and plan instead.', [{ id: 'toolu_grep_1', name: 'grep', input: { pattern: 'parseVersion\\(' } }])),
          to(PLAN_ASK, say(PLAN)),
        ],
        PLAN_ASK,
      ),
  },
  (() => {
    const shown = session();
    return {
      name: 'perm-plan-start-building',
      what: 'A Plan-mode turn ends with a plan and a five-step todo list; the user clicks Start building, the editor switches to Ask and sends "Go ahead with the plan.", and the model starts on step one.',
      run: () =>
        editorFlow(
          ['ask'],
          'plan',
          [
            to(PLAN_ASK, call('I will find parseVersion and its callers first.', [
              { id: 'toolu_grep_1', name: 'grep', input: { pattern: 'parseVersion\\(' } },
              { id: 'toolu_read_0', name: 'read', input: { path: 'src/version.ts' } },
            ])),
            to(PLAN_ASK, call('I will write the steps down first.', [{ id: 'toolu_todo_1', name: 'todo', input: todo(-1) }])),
            to(PLAN_ASK, say(PLAN)),
            to(PLAN_ASK, call('Starting with step 1.', [
              { id: 'toolu_todo_2', name: 'todo', input: todo(0) },
              { id: 'toolu_read_1', name: 'read', input: { path: 'src/version.ts' } },
            ])),
            to(PLAN_ASK, call('Now the change on line 2.', [{ id: 'toolu_edit_1', name: 'edit', input: { path: 'src/version.ts', old_str: "  if (text === '') return [0, 0, 0];", new_str: "  if (text === '') throw new Error('empty version');" } }])),
            to(PLAN_ASK, call('Ticking off step 1.', [{ id: 'toolu_todo_3', name: 'todo', input: done(1) }])),
            to(PLAN_ASK, say('Step 1 is done: parseVersion now throws on an empty string (src/version.ts:2). I stopped here so you can review it; say go on and I will do src/cli.ts next.')),
            to(PLAN_ASK, say('I stopped after step 1 so you can review it; steps 2 to 5 are still open.')),
          ],
          PLAN_ASK,
          {
            update: shown.update,
            permission: allowOnce,
            settled: () =>
              shown.request(async (ctx, sessionId) => {
                await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'ask' });
                await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Go ahead with the plan.' }], _meta: { 'gcode/action': 'start-building' } });
              }),
          },
        ),
    };
  })(),
  (() => {
    // A fixed path outside the workspace and the temp roots the recorder rewrites, so the streamed input keeps its bytes.
    const root = '/tmp/shared-lib';
    const file = `${root}/src/date.ts`;
    const ASK = 'Does the date parser in my shared-lib, /tmp/shared-lib/src/date.ts, handle ISO week dates?';
    return {
      name: 'perm-read-outside-workspace',
      what: 'The model reads a file in another project outside the workspace; the editor shows the card, the user allows it once, and the file reaches the model.',
      run: async () => {
        if (existsSync(root)) throw new Error(`${root} already exists; remove it so this flow does not overwrite or delete someone else's files`);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, DATE);
        try {
          return await editorFlow(
            ['ask'],
            'ask',
            [
              to(ASK, call('I will read the parser in shared-lib.', [{ id: 'toolu_read_1', name: 'read', input: { path: file } }])),
              to(ASK, say('No. parseDate in shared-lib/src/date.ts:12 accepts only YYYY-MM-DD; a week date such as 2026-W03-2 throws "not a date".')),
            ],
            ASK,
            { permission: allowOnce },
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  })(),
  {
    name: 'perm-secret-read',
    what: 'The model reads .env; in Ask mode the editor shows the card, the user allows it once, and the values reach the model.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Which port', call('The port is set in .env, so I will read it.', [{ id: 'toolu_read_1', name: 'read', input: { path: '.env' } }])),
          to('Which port', say('.env sets PORT=8080 (.env:1), so the server listens on 8080.')),
        ],
        'Which port does the server use?',
        { permission: allowOnce, files: { '.env': 'PORT=8080\nDATABASE_URL=postgres://shop:fake-password-123@localhost:5432/shop\nSTRIPE_SECRET_KEY=sk_test_fake_51Hx\n' } },
      ),
  },
  (() => {
    const shown = session();
    return {
      name: 'sess-model-effort',
      what: 'After a turn, the user picks effort high in the model menu; the next turn sends output_config.effort high.',
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to('What does parseVersion return', call('I will read src/version.ts, where parseVersion most likely lives.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'src/version.ts' } }])),
            to('What does parseVersion return', say('parseVersion returns [0, 0, 0] for an empty string (src/version.ts:2).')),
            later('Why does it return', say('Because the check on src/version.ts:2 returns [0, 0, 0] as soon as the text is empty. Without it the result would be the same: splitting an empty string on dots gives one empty part, an empty string converts to the number 0, and the missing parts count as 0.')),
          ],
          'What does parseVersion return for an empty string?',
          {
            update: shown.update,
            settled: () =>
              shown.request(async (ctx, sessionId) => {
                await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'effort', value: 'high' });
                await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Why does it return that?' }] });
              }),
          },
        ),
    };
  })(),
  {
    name: 'start-attach-and-mention',
    what: 'The user mentions src/date.test.ts and pastes a screenshot; the engine reads the file into the prompt and stores the image, and the first request carries both.',
    run: () =>
      blocksFlow(
        [to(TEST_BROKEN, say("The screenshot shows the ISO week test failing. That test, at src/date.test.ts:9, expects parseDate('2026-W03-2') to give year 2026, month 1, day 13, so parseDate in ./date.js does not read ISO week dates yet. I can read src/date.ts and add them."))],
        (workspace) => ({
          prompt: [
            { type: 'text', text: `@src/date.test.ts ${TEST_BROKEN}` },
            { type: 'resource_link', uri: pathToFileURL(path.join(workspace, 'src/date.test.ts')).href, name: 'src/date.test.ts' },
            { type: 'image', data: SCREENSHOT, mimeType: 'image/png', _meta: { 'gcode/attachment': { name: 'Screenshot 2026-10-12 at 09.00.00.png' } } },
          ],
        }),
        { files: { 'src/date.ts': DATE, 'src/date.test.ts': DATE_TEST } },
      ),
  },
  {
    name: 'ed-inline-edit-cmd-k',
    what: 'Cmd-K on lines 12-18 of src/date.ts: the engine sends the file and the selection with only the edit tool, the edit lands, and the model says what it changed.',
    run: () =>
      blocksFlow(
        [
          to(ISO_WEEK, call('I will accept ISO week dates before the YYYY-MM-DD check.', [{ id: 'toolu_edit_1', name: 'edit', input: { path: 'src/date.ts', old_str: WEEK_OLD, new_str: WEEK_NEW } }])),
          to(ISO_WEEK, say('parseDate now reads ISO week dates such as 2026-W03-2 and turns them into the calendar date.')),
        ],
        (workspace) => ({ prompt: [{ type: 'text', text: ISO_WEEK }], _meta: { 'gcode/inlineEdit': { path: path.join(workspace, 'src/date.ts'), startLine: 12, endLine: 18 } } }),
        { files: { 'src/date.ts': DATE } },
      ),
  },
  {
    name: 'ed-inline-edit-cmd-k-fails',
    what: "Cmd-K where the model's old_str never matches the file: Geno lets it try three times, then makes the last call with no tools, and the model says why it could not edit.",
    run: () => {
      const miss = (id: string, text: string) => call(text, [{ id, name: 'edit', input: { path: 'src/date.ts', old_str: WEEK_OLD.replace('text.trim()', 'text'), new_str: WEEK_NEW } }]);
      return blocksFlow(
        [
          to(ISO_WEEK, miss('toolu_edit_1', 'I will accept ISO week dates before the YYYY-MM-DD check.')),
          to(ISO_WEEK, miss('toolu_edit_2', 'The edit did not apply; I will try again.')),
          to(ISO_WEEK, miss('toolu_edit_3', 'Trying the same change once more.')),
          to(ISO_WEEK, say('I could not apply the change: my old_str did not match lines 13-14 of src/date.ts. Nothing was changed.')),
        ],
        (workspace) => ({ prompt: [{ type: 'text', text: ISO_WEEK }], _meta: { 'gcode/inlineEdit': { path: path.join(workspace, 'src/date.ts'), startLine: 12, endLine: 18 } } }),
        { files: { 'src/date.ts': DATE } },
      );
    },
  },
];

import { allowOnce, call, editorFlow, firstText, type Flow, type Responder, say, type ScriptEntry } from './kit.js';

/** A request from Auto's classifier, which offers only its verdict tool. */
const isJudge = (body: { readonly tools?: readonly { readonly name: string }[] }): boolean => (body.tools ?? []).some((tool) => tool.name === 'verdict');
/** The classifier's next request. */
const judge = (answer: Responder): ScriptEntry => ({ when: (request) => isJudge(request.body), answer });
/** The chat model's next request in the session whose first prompt holds `marker`. */
const chat = (marker: string, answer: Responder): ScriptEntry => ({ when: (request) => !isJudge(request.body) && firstText(request.body).includes(marker), answer });

const verdict = (id: string, value: 'allow' | 'ask' | 'deny', reason: string) => call('', [{ id, name: 'verdict', input: { reason, verdict: value } }]);
const rmDist = (id: string, text: string) => call(text, [{ id, name: 'bash', input: { command: 'rm -rf dist', description: 'Delete the dist folder' } }]);

const DIST = {
  '.gitignore': 'node_modules/\ndist/\n',
  'dist/version.js': `export function parseVersion(text) {
  const [major, minor, patch] = text.split('.').map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}
`,
  'dist/cli.js': `import { parseVersion } from './version.js';
console.log(parseVersion(process.argv[2] ?? ''));
`,
};

const DELETE = 'Delete the dist folder. It only holds stale build output.';
const STALE = 'Is dist/version.js out of date with src/version.ts?';

/** The classifier on a model whose request lets it answer in text: Claude Sonnet 5.5 is not forced to call the tool. */
const CLAUDE_CLASSIFIER = { GCODE_CLASSIFIER_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-fake' };
const NO_TOOL = 'This deletes dist, which the user asked to remove, and dist is build output that a build makes again. It should run.';
const NO_TOOL_AGAIN = 'The user asked to delete dist, and it holds build output, so removing it is a routine step. Verdict: allow.';

export const AUTO: readonly Flow[] = [
  {
    name: 'perm-auto-classifier-allow',
    what: 'In Auto the model runs rm -rf dist; the rule sends it to the classifier, which allows it, and it runs in the sandbox.',
    run: () =>
      editorFlow(
        ['ask', 'auto'],
        'auto',
        [
          chat(DELETE, rmDist('toolu_bash_1', 'I will delete dist.')),
          judge(verdict('toolu_verdict_1', 'allow', 'Deletes dist, build output the user asked to remove.')),
          chat(DELETE, say('Deleted dist.')),
        ],
        DELETE,
        { files: DIST },
      ),
  },
  {
    name: 'perm-auto-classifier-deny',
    what: 'In Auto the model tries rm -rf dist when the user only asked a question; the classifier denies it, and the model reads the files instead.',
    run: () =>
      editorFlow(
        ['ask', 'auto'],
        'auto',
        [
          chat(STALE, rmDist('toolu_bash_1', 'dist is build output, so I will delete it and rebuild it from src.')),
          judge(verdict('toolu_verdict_1', 'deny', 'Deletes dist, but the user asked whether it is out of date, not to remove it.')),
          chat(
            STALE,
            call('Deleting dist was refused. I will compare the two files instead.', [
              { id: 'toolu_read_1', name: 'read', input: { path: 'dist/version.js' } },
              { id: 'toolu_read_2', name: 'read', input: { path: 'src/version.ts' } },
            ]),
          ),
          chat(
            STALE,
            say(
              "Yes. dist/version.js has no `if (text === '')` line, which src/version.ts:2 has, so dist was built before that check was added. Rebuild it to bring it up to date. I did not delete dist, because Auto mode's classifier refused that.",
            ),
          ),
        ],
        STALE,
        { files: DIST },
      ),
  },
  {
    name: 'perm-auto-classifier-unevaluated',
    what: 'The classifier answers in text with no verdict on both tries, so Auto refuses rm -rf dist as not evaluated, and the model tells the user.',
    run: () =>
      editorFlow(
        ['ask', 'auto'],
        'auto',
        [
          chat(DELETE, rmDist('toolu_bash_1', 'I will delete dist.')),
          judge(say(NO_TOOL)),
          judge(say(NO_TOOL_AGAIN)),
          chat(DELETE, say('I could not delete dist. Auto mode could not get a verdict on `rm -rf dist` from its classifier, so Geno did not run it. Run `rm -rf dist` yourself, or tell me to try again.')),
        ],
        DELETE,
        { files: DIST },
        CLAUDE_CLASSIFIER,
      ),
  },
  {
    name: 'perm-auto-classifier-fallback',
    what: 'The classifier gives no verdict again and again; after three blocks in a row, Auto shows the user the card for the fourth.',
    run: () =>
      editorFlow(
        ['ask', 'auto'],
        'auto',
        [
          chat(DELETE, rmDist('toolu_bash_1', 'I will delete dist.')),
          judge(say(NO_TOOL)),
          judge(say(NO_TOOL_AGAIN)),
          chat(DELETE, rmDist('toolu_bash_2', 'Auto mode could not evaluate the command. I will try once more.')),
          judge(say(NO_TOOL)),
          judge(say(NO_TOOL_AGAIN)),
          chat(DELETE, say('I could not delete dist. Auto mode could not get a verdict on `rm -rf dist` twice, so Geno did not run it. Run `rm -rf dist` yourself, or tell me to try again.')),
          chat(DELETE, rmDist('toolu_bash_3', 'I will try again.')),
          judge(say(NO_TOOL)),
          judge(say(NO_TOOL_AGAIN)),
          chat(DELETE, rmDist('toolu_bash_4', 'It was not evaluated again. One more try.')),
          judge(say(NO_TOOL)),
          judge(say(NO_TOOL_AGAIN)),
          chat(DELETE, say('Deleted dist.')),
        ],
        [DELETE, 'Try again.'],
        { files: DIST, permission: allowOnce },
        CLAUDE_CLASSIFIER,
      ),
  },
];

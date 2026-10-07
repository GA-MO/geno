/** The workflow fixture's files, command and the fake model's answers, shared by the suite and the test that launches it. */
export const WORKFLOW = {
  description: 'Review the changes, fix what the review found, then verify the fix.',
  input: 'What to focus on',
  maxCostUsd: 0.4,
  steps: [
    { id: 'review', role: 'review', prompt: '[wf-review] Review {{input}}.', schema: { findings: 'string[]' } },
    { id: 'fix', role: 'worker', prompt: ['[wf-fix] Fix these findings:', '{{review.findings}}'], maxCostUsd: 0.15, maxTurns: 10 },
    { id: 'verify', role: 'review', prompt: '[wf-verify] Did the fix hold?\n{{fix}}', schema: { pass: 'boolean' } },
    { gate: { field: 'verify.pass', equals: true } },
  ],
};

export const FILES = {
  'src/app.ts': 'export const port = 3000;\n',
  '.g-code/workflows/review-fix-verify.json': `${JSON.stringify(WORKFLOW, null, 2)}\n`,
} as const;

export const COMMAND = '/workflow review-fix-verify the port export';

/** Each step's first message carries its marker; the starting session's woken turn opens with its own prompt. */
export const ANSWERS: Readonly<Record<string, string>> = {
  '[wf-review]': 'One finding.\n\n```json\n{"findings": ["src/app.ts:1 port has no type"]}\n```',
  '[wf-fix]': 'Typed port as a number.',
  '[wf-verify]': 'It holds.\n\n```json\n{"pass": true}\n```',
  'Run the workflow': 'The workflow finished: the review found one thing, the fix typed port, and the check held.',
};

/** The fix step answers this late, so the suite sees the run at work in Tasks. */
export const SLOW_STEP = '[wf-fix]';
export const SLOW_MS = 6000;

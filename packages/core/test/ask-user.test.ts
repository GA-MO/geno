import { describe, expect, it } from 'vitest';
import {
  askUserAnswerOf,
  askUserContent,
  askUserForm,
  askUserMessage,
  askUserResult,
  askUserText,
  askUserTitle,
  parseAskUser,
  type AskUserRequest,
} from '../src/index.js';

const option = (label: string, extra: Record<string, unknown> = {}) => ({ label, description: `About ${label}.`, ...extra });
const question = (id: string, extra: Record<string, unknown> = {}) => ({ id, header: 'Layout', question: 'Which layout?', options: [option('Grid'), option('List')], ...extra });

const problem = (raw: unknown): string => {
  const parsed = parseAskUser(raw);
  if (parsed.ok) throw new Error(`expected a problem, parsed ${JSON.stringify(parsed.value)}`);
  return parsed.problem;
};

const TWO: AskUserRequest = {
  questions: [
    {
      id: 'button',
      header: 'Button',
      question: 'Which button style?',
      multiSelect: false,
      options: [
        { label: 'Solid', description: 'A filled button.', recommended: true, preview: '```css\n.b { background: black; }\n```' },
        { label: 'Ghost', description: 'Text only until hovered.' },
      ],
    },
    {
      id: 'targets',
      header: 'Targets',
      question: 'Which platforms?',
      multiSelect: true,
      options: [
        { label: 'Web', description: 'The browser build.' },
        { label: 'Desktop', description: 'The Electron build.' },
        { label: 'Mobile', description: 'The React Native build.' },
      ],
    },
  ],
};

describe('parseAskUser', () => {
  it('reads up to four questions, each with two to four described options, and defaults multiSelect to false', () => {
    const parsed = parseAskUser({ questions: [question('a', { options: [option('Grid', { recommended: true, preview: '| a | b |' }), option('List')] }), question('b', { multiSelect: true })] });
    expect(parsed).toEqual({
      ok: true,
      value: {
        questions: [
          {
            id: 'a',
            header: 'Layout',
            question: 'Which layout?',
            multiSelect: false,
            options: [
              { label: 'Grid', description: 'About Grid.', recommended: true, preview: '| a | b |' },
              { label: 'List', description: 'About List.' },
            ],
          },
          { id: 'b', header: 'Layout', question: 'Which layout?', multiSelect: true, options: [{ label: 'Grid', description: 'About Grid.' }, { label: 'List', description: 'About List.' }] },
        ],
      },
    });
  });

  it('holds the limits: 1 to 4 questions, 2 to 4 options, a header of 12 characters or fewer', () => {
    expect(problem({ questions: [] })).toBe('ask_user takes 1 to 4 questions');
    expect(problem({ questions: ['a', 'b', 'c', 'd', 'e'].map((id) => question(id)) })).toBe('ask_user takes 1 to 4 questions');
    expect(parseAskUser({ questions: ['a', 'b', 'c', 'd'].map((id) => question(id)) }).ok).toBe(true);
    expect(problem({ questions: [question('a', { options: [option('Grid')] })] })).toBe('question 1 needs 2 to 4 options; Other is added for you');
    expect(problem({ questions: [question('a', { options: ['A', 'B', 'C', 'D', 'E'].map((l) => option(l)) })] })).toBe('question 1 needs 2 to 4 options; Other is added for you');
    expect(parseAskUser({ questions: [question('a', { header: 'Twelve chars' })] }).ok).toBe(true);
    expect(problem({ questions: [question('a', { header: 'Thirteen char' })] })).toBe('question 1\'s header "Thirteen char" is longer than 12 characters');
  });

  it('rejects a listed Other, since every question offers it', () => {
    expect(problem({ questions: [question('a', { options: [option('Grid'), option('Other')] })] })).toBe('question 1, option 2 is "Other". Do not list Other: the card always offers it');
    expect(problem({ questions: [question('a', { options: [option('Grid'), option('other (type it)')] })] })).toMatch(/Do not list Other/);
    expect(parseAskUser({ questions: [question('a', { options: [option('Grid'), option('Otherworldly')] })] }).ok).toBe(true);
  });

  it('rejects anything else with a message the model can act on', () => {
    expect(problem({ questions: [question('a')], extra: 1 })).toBe('ask_user has an unknown field "extra"');
    expect(problem({ questions: [question('a', { color: 'red' })] })).toBe('question 1 has an unknown field "color"');
    expect(problem({ questions: [question('a', { options: [option('Grid'), { label: 'List' }] })] })).toBe('question 1, option 2 ("List") needs a description');
    expect(problem({ questions: [question('a'), question('a')] })).toBe('two questions have the id "a"');
    expect(problem({ questions: [question('1st')] })).toMatch(/^question 1 needs an id/);
    expect(problem({ questions: [question('a', { options: [option('Grid'), option('grid')] })] })).toBe('question 1 lists "grid" twice');
    expect(problem({ questions: [question('a', { options: [option('Grid', { recommended: true }), option('List', { recommended: true })] })] })).toBe('question 1 recommends more than one option');
    expect(problem({ questions: [question('a', { multiSelect: 'yes' })] })).toBe("question 1's multiSelect must be true or false");
    expect(problem('Which?')).toBe('ask_user takes an object with questions');
  });

  it('reads the old single-question shape as one question, so older calls and logs still parse', () => {
    expect(parseAskUser({ question: 'Which database?', options: ['Postgres', 'SQLite'] })).toEqual({
      ok: true,
      value: { questions: [{ id: 'choice', header: 'Question', question: 'Which database?', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
    });
    expect(parseAskUser({ question: 'Why?' })).toEqual({ ok: true, value: { questions: [{ id: 'choice', header: 'Question', question: 'Why?', multiSelect: false, options: [] }] } });
    expect(parseAskUser({ question: 'Why?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).ok, 'U13 took at most six').toBe(false);
  });
});

describe('the ACP form', () => {
  it('maps each question to a choice field keyed by its id and an Other field, with descriptions and the recommended marker', () => {
    expect(askUserForm(TWO)).toEqual({
      type: 'object',
      properties: {
        button: {
          type: 'string',
          title: 'Button',
          description: 'Which button style?',
          oneOf: [
            { const: 'Solid', title: 'Solid (Recommended)', description: 'A filled button.' },
            { const: 'Ghost', title: 'Ghost', description: 'Text only until hovered.' },
          ],
        },
        'button.other': { type: 'string', title: 'Other', description: 'Your own answer to: Which button style?' },
        targets: {
          type: 'array',
          title: 'Targets',
          description: 'Which platforms?',
          items: {
            anyOf: [
              { const: 'Web', title: 'Web', description: 'The browser build.' },
              { const: 'Desktop', title: 'Desktop', description: 'The Electron build.' },
              { const: 'Mobile', title: 'Mobile', description: 'The React Native build.' },
            ],
          },
        },
        'targets.other': { type: 'string', title: 'Other', description: 'Your own answer to: Which platforms?' },
      },
    });
    expect(askUserMessage(TWO)).toBe('Geno has 2 questions: Button, Targets');
  });

  it('asks an old-shape question as a form with the options to pick and a free-text answer', () => {
    const legacy = parseAskUser({ question: 'Which?', options: ['a', 'b'] });
    if (!legacy.ok) throw new Error(legacy.problem);
    expect(askUserForm(legacy.value).properties).toEqual({
      choice: { type: 'string', title: 'Question', description: 'Which?', oneOf: [{ const: 'a', title: 'a' }, { const: 'b', title: 'b' }] },
      'choice.other': { type: 'string', title: 'Other', description: 'Your own answer to: Which?' },
    });
    const open = parseAskUser({ question: 'Why?', options: [] });
    if (!open.ok) throw new Error(open.problem);
    expect(askUserForm(open.value).properties, 'no options leaves only the free-text answer').toEqual({ 'choice.other': { type: 'string', title: 'Question', description: 'Why?' } });
    expect(askUserMessage(legacy.value)).toBe('Which?');
  });

  it('round-trips answers through the form content, dropping labels the question never offered', () => {
    const answers = { button: { picked: ['Ghost'] }, targets: { picked: ['Web', 'Mobile'], other: 'a CLI' } };
    const content = askUserContent(TWO, answers);
    expect(content).toEqual({ button: 'Ghost', targets: ['Web', 'Mobile'], 'targets.other': 'a CLI' });
    expect(askUserAnswerOf(TWO, content)).toEqual({ kind: 'answered', answers });
    expect(askUserAnswerOf(TWO, { button: 'Huge', targets: ['Web', 'Watch'] })).toEqual({ kind: 'answered', answers: { targets: { picked: ['Web'] } } });
    expect(askUserAnswerOf(TWO, { button: ['Solid', 'Ghost'] }), 'a single-select keeps one label').toEqual({ kind: 'answered', answers: { button: { picked: ['Solid'] } } });
    expect(askUserAnswerOf(TWO, { 'button.other': '   ' }), 'nothing answered declines').toEqual({ kind: 'declined' });
  });
});

describe('what the model reads', () => {
  it('says the single answer as U13 did, and each question\'s answer when there are several', () => {
    const legacy = parseAskUser({ question: 'Which?', options: ['a', 'b'] });
    if (!legacy.ok) throw new Error(legacy.problem);
    expect(askUserResult(legacy.value, { kind: 'answered', answers: { choice: { picked: ['b'] } } })).toBe('The user answered: b');
    expect(askUserResult(legacy.value, { kind: 'answered', answers: { choice: { picked: [], other: 'neither' } } })).toBe('The user answered: neither');
    expect(askUserResult(legacy.value, { kind: 'declined' })).toMatch(/^The user declined to answer/);
    expect(askUserResult(TWO, { kind: 'answered', answers: { button: { picked: ['Solid'] }, targets: { picked: ['Web', 'Desktop'], other: 'a CLI' } } })).toBe(
      ['The user answered:', '- Button (Which button style?): Solid', '- Targets (Which platforms?): Web, Desktop, "a CLI" (in their own words)'].join('\n'),
    );
  });

  it('gives an editor that cannot show the card the questions and options as text, to ask in plain words', () => {
    expect(askUserText(TWO)).toBe(
      [
        '1. Button: Which button style?',
        '   1. Solid (Recommended): A filled button.',
        '   2. Ghost: Text only until hovered.',
        '   Pick one, or answer in your own words.',
        '',
        '2. Targets: Which platforms?',
        '   1. Web: The browser build.',
        '   2. Desktop: The Electron build.',
        '   3. Mobile: The React Native build.',
        '   Pick any number, or answer in your own words.',
      ].join('\n'),
    );
    expect(askUserResult(TWO, { kind: 'unshown' })).toBe(`The editor cannot show the question card. End your turn now with these questions as plain text, and the user will answer in their next message:\n\n${askUserText(TWO)}`);
  });

  it('titles the call with the question, or the headers', () => {
    expect(askUserTitle(TWO)).toBe('Button, Targets');
    expect(askUserTitle({ questions: [TWO.questions[0]!] })).toBe('Which button style?');
  });
});

/**
 * `ask_user`: one card with up to four questions, each a tab. The model writes the request; the editor shows it as
 * an ACP form elicitation and sends back an answer per question.
 */

export type AskUserOption = {
  readonly label: string;
  /** Absent only for a question asked in U13's single-question shape, whose options were bare labels. */
  readonly description?: string;
  readonly recommended?: true;
  /** Short markdown or a code block, shown beside the list while the option has the focus. */
  readonly preview?: string;
};

export type AskUserQuestion = {
  readonly id: string;
  /** The tab label. */
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  /** Never lists "Other": every question offers it. */
  readonly options: readonly AskUserOption[];
};

export type AskUserRequest = { readonly questions: readonly AskUserQuestion[] };

/** The labels picked, and the user's own words when they chose Other. */
export type QuestionAnswer = { readonly picked: readonly string[]; readonly other?: string };

/** Keyed by question id. */
export type AskUserAnswers = Readonly<Record<string, QuestionAnswer>>;

export type AskUserAnswer = { readonly kind: 'answered'; readonly answers: AskUserAnswers } | { readonly kind: 'declined' };

/** What the editor did with the question: an answer, a refusal, or no card at all because it could not show the form. */
export type AskUserReply = AskUserAnswer | { readonly kind: 'unshown' };

export const ASK_USER_LIMITS = {
  questions: { min: 1, max: 4 },
  options: { min: 2, max: 4 },
  header: 12,
  label: 60,
  preview: 2000,
  /** U13's shape took up to six bare labels. */
  legacyOptions: 6,
} as const;

/** The id a question asked in U13's shape gets. It was that form's field name, so its answers still parse. */
export const LEGACY_QUESTION_ID = 'choice';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

export const ASK_USER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: ASK_USER_LIMITS.questions.min,
      maxItems: ASK_USER_LIMITS.questions.max,
      description: 'The questions, shown as tabs of one card and answered together.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: ID.source, description: 'A short unique key for the question, such as "layout".' },
          header: { type: 'string', maxLength: ASK_USER_LIMITS.header, description: `The tab label, ${ASK_USER_LIMITS.header} characters or fewer, such as "Layout".` },
          question: { type: 'string', description: 'The question, in one or two plain sentences.' },
          multiSelect: { type: 'boolean', description: 'True when the user may pick more than one option. Defaults to false.' },
          options: {
            type: 'array',
            minItems: ASK_USER_LIMITS.options.min,
            maxItems: ASK_USER_LIMITS.options.max,
            description: 'The likely answers. Do not list "Other": the card always offers it, for an answer in the user\'s own words.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', maxLength: ASK_USER_LIMITS.label, description: 'One to five words.' },
                description: { type: 'string', description: 'What choosing it means, in one sentence.' },
                recommended: { type: 'boolean', description: 'Marks the option you recommend; at most one per question.' },
                preview: { type: 'string', maxLength: ASK_USER_LIMITS.preview, description: 'Optional short markdown or code block that shows the option, such as a snippet or a layout sketch.' },
              },
              required: ['label', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'header', 'question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });
const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const text = (raw: unknown): raw is string => typeof raw === 'string' && raw.trim() !== '';
const extraKey = (raw: Record<string, unknown>, allowed: readonly string[]): string | undefined => Object.keys(raw).find((key) => !allowed.includes(key));
const isOther = (label: string): boolean => /^other\b/i.test(label.trim());
const between = (n: number, { min, max }: { readonly min: number; readonly max: number }) => n >= min && n <= max;

function parseOption(raw: unknown, where: string): Parsed<AskUserOption> {
  if (!isRecord(raw)) return fail(`${where} must be an object with a label and a description`);
  const extra = extraKey(raw, ['label', 'description', 'recommended', 'preview']);
  if (extra !== undefined) return fail(`${where} has an unknown field "${extra}"`);
  const { label, description, recommended, preview } = raw;
  if (!text(label)) return fail(`${where} needs a label`);
  if (label.trim().length > ASK_USER_LIMITS.label) return fail(`${where}'s label is longer than ${ASK_USER_LIMITS.label} characters`);
  if (isOther(label)) return fail(`${where} is "${label.trim()}". Do not list Other: the card always offers it`);
  if (!text(description)) return fail(`${where} ("${label.trim()}") needs a description`);
  if (recommended !== undefined && typeof recommended !== 'boolean') return fail(`${where}'s recommended must be true or false`);
  if (preview !== undefined && typeof preview !== 'string') return fail(`${where}'s preview must be a string`);
  if (typeof preview === 'string' && preview.length > ASK_USER_LIMITS.preview) return fail(`${where}'s preview is longer than ${ASK_USER_LIMITS.preview} characters`);
  return {
    ok: true,
    value: {
      label: label.trim(),
      description: description.trim(),
      ...(recommended === true ? { recommended: true as const } : {}),
      ...(typeof preview === 'string' && preview.trim() !== '' ? { preview } : {}),
    },
  };
}

function parseQuestion(raw: unknown, n: number): Parsed<AskUserQuestion> {
  const where = `question ${n}`;
  if (!isRecord(raw)) return fail(`${where} must be an object`);
  const extra = extraKey(raw, ['id', 'header', 'question', 'multiSelect', 'options']);
  if (extra !== undefined) return fail(`${where} has an unknown field "${extra}"`);
  const { id, header, question, multiSelect = false, options } = raw;
  if (typeof id !== 'string' || !ID.test(id)) return fail(`${where} needs an id of letters, digits, - and _, starting with a letter`);
  if (!text(header)) return fail(`${where} needs a header`);
  if (header.trim().length > ASK_USER_LIMITS.header) return fail(`${where}'s header "${header.trim()}" is longer than ${ASK_USER_LIMITS.header} characters`);
  if (!text(question)) return fail(`${where} needs the question text`);
  if (typeof multiSelect !== 'boolean') return fail(`${where}'s multiSelect must be true or false`);
  if (!Array.isArray(options) || !between(options.length, ASK_USER_LIMITS.options))
    return fail(`${where} needs ${ASK_USER_LIMITS.options.min} to ${ASK_USER_LIMITS.options.max} options; Other is added for you`);
  const parsed: AskUserOption[] = [];
  for (const [i, option] of options.entries()) {
    const one = parseOption(option, `${where}, option ${i + 1}`);
    if (!one.ok) return one;
    if (parsed.some((o) => o.label.toLowerCase() === one.value.label.toLowerCase())) return fail(`${where} lists "${one.value.label}" twice`);
    parsed.push(one.value);
  }
  if (parsed.filter((o) => o.recommended).length > 1) return fail(`${where} recommends more than one option`);
  return { ok: true, value: { id, header: header.trim(), question: question.trim(), multiSelect, options: parsed } };
}

/** U13's `{ question, options? }`: one question with bare labels, kept so older callers and logs still read. */
function parseLegacy(raw: Record<string, unknown>): Parsed<AskUserRequest> {
  const extra = extraKey(raw, ['question', 'options']);
  if (extra !== undefined) return fail(`ask_user has an unknown field "${extra}"`);
  const { question, options = [] } = raw;
  if (!text(question)) return fail('ask_user needs questions');
  if (!Array.isArray(options) || options.length > ASK_USER_LIMITS.legacyOptions || !options.every(text)) return fail('ask_user needs questions');
  return {
    ok: true,
    value: {
      questions: [{ id: LEGACY_QUESTION_ID, header: 'Question', question: question.trim(), multiSelect: false, options: options.map((label) => ({ label: label.trim() })) }],
    },
  };
}

/** The model's `ask_user` input as a request, or what is wrong with it, in words the model can act on. */
export function parseAskUser(raw: unknown): Parsed<AskUserRequest> {
  if (!isRecord(raw)) return fail('ask_user takes an object with questions');
  if (!('questions' in raw) && 'question' in raw) return parseLegacy(raw);
  const extra = extraKey(raw, ['questions']);
  if (extra !== undefined) return fail(`ask_user has an unknown field "${extra}"`);
  const { questions } = raw;
  if (!Array.isArray(questions) || !between(questions.length, ASK_USER_LIMITS.questions))
    return fail(`ask_user takes ${ASK_USER_LIMITS.questions.min} to ${ASK_USER_LIMITS.questions.max} questions`);
  const parsed: AskUserQuestion[] = [];
  for (const [i, question] of questions.entries()) {
    const one = parseQuestion(question, i + 1);
    if (!one.ok) return one;
    if (parsed.some((q) => q.id === one.value.id)) return fail(`two questions have the id "${one.value.id}"`);
    parsed.push(one.value);
  }
  return { ok: true, value: { questions: parsed } };
}

/** The tool call's one-line title: the question, or the tab headers when there are several. */
export const askUserTitle = ({ questions }: AskUserRequest): string =>
  questions.length === 1 ? questions[0]!.question : questions.map((q) => q.header).join(', ');

/** Whether an answer says anything: a label picked, or words typed under Other. */
export const isAnswered = (answer: QuestionAnswer | undefined): boolean => answer !== undefined && (answer.picked.length > 0 || (answer.other ?? '').trim() !== '');

/** The questions and options as plain text, for an editor that cannot show the card. */
export function askUserText({ questions }: AskUserRequest): string {
  return questions
    .map((q, i) => {
      const lines = q.options.map((o, j) => `   ${j + 1}. ${o.label}${o.recommended ? ' (Recommended)' : ''}${o.description === undefined ? '' : `: ${o.description}`}`);
      const how = q.multiSelect ? 'Pick any number, or answer in your own words.' : 'Pick one, or answer in your own words.';
      return [`${i + 1}. ${q.header}: ${q.question}`, ...lines, `   ${how}`].join('\n');
    })
    .join('\n\n');
}

const quoted = (words: string): string => `"${words.trim()}" (in their own words)`;

const answerWords = (answer: QuestionAnswer | undefined): string =>
  isAnswered(answer) ? [...answer!.picked, ...((answer!.other ?? '').trim() === '' ? [] : [quoted(answer!.other!)])].join(', ') : 'no answer';

/** What the user's reply tells the model. */
export function askUserResult(request: AskUserRequest, reply: AskUserReply): string {
  if (reply.kind === 'declined') return 'The user declined to answer. Go on with your best judgment and say what you assumed.';
  if (reply.kind === 'unshown')
    return `The editor cannot show the question card. End your turn now with these questions as plain text, and the user will answer in their next message:\n\n${askUserText(request)}`;
  const { questions } = request;
  if (questions.length === 1) {
    const [only] = questions;
    const answer = reply.answers[only!.id];
    const words = (answer?.other ?? '').trim() !== '' && answer!.picked.length === 0 ? answer!.other!.trim() : answerWords(answer);
    return `The user answered: ${words}`;
  }
  return ['The user answered:', ...questions.map((q) => `- ${q.header} (${q.question}): ${answerWords(reply.answers[q.id])}`)].join('\n');
}

/**
 * The form an `ask_user` request becomes in ACP's `elicitation/create`, as far as a form can say it: per question a
 * single-select string (`oneOf`) or a multi-select array (`anyOf`) keyed by the question's id, titled by its header
 * and described by its text, each option with its description and "(Recommended)" in its title; and a free-text
 * field for Other. A form has no previews and no way to pair a question with its Other field, so the request itself
 * travels in the elicitation's `_meta` too.
 */
export const ASK_USER_META = 'gcode/ask_user';

export const otherField = (id: string): string => `${id}.other`;

type EnumOption = { readonly const: string; readonly title: string; readonly description?: string };
export type AskUserFormProperty =
  | { readonly type: 'string'; readonly title: string; readonly description: string; readonly oneOf?: readonly EnumOption[] }
  | { readonly type: 'array'; readonly title: string; readonly description: string; readonly items: { readonly anyOf: readonly EnumOption[] } };
export type AskUserForm = { readonly type: 'object'; readonly properties: Readonly<Record<string, AskUserFormProperty>> };

const enumOption = (o: AskUserOption): EnumOption => ({
  const: o.label,
  title: o.recommended ? `${o.label} (Recommended)` : o.label,
  ...(o.description === undefined ? {} : { description: o.description }),
});

export function askUserForm({ questions }: AskUserRequest): AskUserForm {
  const properties: Record<string, AskUserFormProperty> = {};
  for (const q of questions) {
    const options = q.options.map(enumOption);
    if (options.length > 0)
      properties[q.id] = q.multiSelect
        ? { type: 'array', title: q.header, description: q.question, items: { anyOf: options } }
        : { type: 'string', title: q.header, description: q.question, oneOf: options };
    properties[otherField(q.id)] = { type: 'string', title: options.length === 0 ? q.header : 'Other', description: options.length === 0 ? q.question : `Your own answer to: ${q.question}` };
  }
  return { type: 'object', properties };
}

/** The message an elicitation carries: the question, or how many there are. */
export const askUserMessage = ({ questions }: AskUserRequest): string =>
  questions.length === 1 ? questions[0]!.question : `Geno has ${questions.length} questions: ${questions.map((q) => q.header).join(', ')}`;

/** An answer as the form's content: the label or labels under the question's id, the user's words under its Other field. */
export function askUserContent({ questions }: AskUserRequest, answers: AskUserAnswers): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {};
  for (const q of questions) {
    const answer = answers[q.id];
    if (answer === undefined) continue;
    const picked = answer.picked.filter((label) => q.options.some((o) => o.label === label));
    if (picked.length > 0) content[q.id] = q.multiSelect ? picked : picked[0]!;
    if ((answer.other ?? '').trim() !== '') content[otherField(q.id)] = answer.other!.trim();
  }
  return content;
}

/** The form's content back as answers, keeping only labels the question offered. Nothing answered declines. */
export function askUserAnswerOf({ questions }: AskUserRequest, content: Readonly<Record<string, unknown>>): AskUserAnswer {
  const answers: Record<string, QuestionAnswer> = {};
  for (const q of questions) {
    const raw = content[q.id];
    const labels = (Array.isArray(raw) ? raw : [raw]).filter((label): label is string => typeof label === 'string' && q.options.some((o) => o.label === label));
    const picked = q.multiSelect ? labels : labels.slice(0, 1);
    const other = content[otherField(q.id)];
    const answer: QuestionAnswer = { picked, ...(typeof other === 'string' && other.trim() !== '' ? { other: other.trim() } : {}) };
    if (isAnswered(answer)) answers[q.id] = answer;
  }
  return Object.keys(answers).length === 0 ? { kind: 'declined' } : { kind: 'answered', answers };
}

import type { ProviderName } from './providers.js';

/**
 * Which system prompt a model gets (P24): short principles for a strong model, as Claude Code gives Opus, or
 * detailed rule blocks for a cheap one, as it gives Haiku.
 */
export const PROMPT_TIERS = ['principles', 'rules'] as const;
export type PromptTier = (typeof PROMPT_TIERS)[number];
export const isPromptTier = (raw: string): raw is PromptTier => (PROMPT_TIERS as readonly string[]).includes(raw);

/** `adaptive` asks for Anthropic's adaptive thinking; `omit` sends no thinking field, leaving the provider's default. */
export type Thinking = 'adaptive' | 'omit';

/**
 * How a call asks for no thinking. `disabled` sends `{type: 'disabled'}`. `between_tools` sends Claude Sonnet 5.5's
 * `{type: 'between_tools'}`, which refuses `disabled` and an effort above `high`. `omit` sends no thinking field, for a
 * model whose thinking cannot be turned off, such as Claude Opus 5.5, which refuses both.
 */
export type ThinkingOff = 'disabled' | 'between_tools' | 'omit';

/** The thinking field of a call that asks for no thinking, spread into the request. */
export const thinkingOffField = (off: ThinkingOff): { readonly thinking?: { readonly type: 'disabled' | 'between_tools' } } => (off === 'omit' ? {} : { thinking: { type: off } });

/** How long a prompt cache entry lives. `5m` is the default and sends no TTL; Anthropic bills a `1h` write at 2x input. */
export type CacheTtl = '5m' | '1h';

/** The fields a row may choose without a source. A window and an output limit always have one. */
export type GuessedField = 'thinking' | 'effort' | 'promptTier' | 'cacheTtl' | 'compactAt' | 'subagents';

/** What Geno knows about one model: the limits a request must respect, and the settings it sends. */
export type ModelCapabilities = {
  /** The context window in tokens; undefined when no source gives it, never a guess. */
  readonly window: number | undefined;
  /** The most output tokens a call may ask for, before the request clamps it to what the window has left. */
  readonly maxOutput: number;
  readonly thinking: Thinking;
  readonly thinkingOff: ThinkingOff;
  /**
   * Whether the model takes a forced `tool_choice` (`tool` or `any`). Claude Opus and Sonnet 5.5 refuse one, so a call
   * that would force a tool offers it with `auto` there, and a run's last call goes out with the tools off instead.
   */
  readonly forcesTool: boolean;
  /** Whether the model takes a temperature other than its default. Claude Opus and Sonnet 5.5 refuse one. */
  readonly temperature: boolean;
  /**
   * Whether the model starts subagents well, so the `agent` tool is on by default in `DEFAULT_AGENT_TOOL_MODES`. Claude
   * does, as in Claude Code; qwen3.8-flash never called it in the P25 eval (docs/results/p25-agent-default.md).
   */
  readonly subagents: boolean;
  /** Whether a request carries `output_config.effort`. Haiku 4.5 refuses a request that does. */
  readonly effort: boolean;
  readonly promptTier: PromptTier;
  readonly cacheTtl: CacheTtl;
  /** A tool result longer than this many characters goes to a spill file, leaving the model its head, tail and path. */
  readonly spillChars: number;
  /** The context size, in tokens, at which Geno compacts before a call; undefined, so never, when the window is unknown. */
  readonly compactAt: number | undefined;
  /** Where the window and the output limit come from. */
  readonly source: string;
  readonly guessed: readonly GuessedField[];
};

/**
 * Geno's spill limit for every model so far. Claude Code spills at about 30,000; Geno keeps its own, which leaves room
 * for the 2,000-character head and tail it shows of a long build log (parity A/D-09).
 */
const SPILL_CHARS = 24_000;

type Choices = Pick<ModelCapabilities, 'thinking' | 'thinkingOff' | 'forcesTool' | 'temperature' | 'subagents' | 'effort' | 'promptTier' | 'cacheTtl' | 'guessed'>;

/** A known model. `compactAt` is 80% of the window, Geno's trigger since U47, unless a row's eval says otherwise. */
const known = (source: string, window: number, maxOutput: number, choices: Choices, compactAt = Math.floor(0.8 * window)): ModelCapabilities => ({
  window,
  maxOutput,
  compactAt,
  spillChars: SPILL_CHARS,
  source,
  ...choices,
});

const CLAUDE_DOCS = 'https://platform.claude.com/docs/en/about-claude/models/overview';
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const modelStudioDocs = (page: string): string => `https://www.alibabacloud.com/help/en/model-studio/${page}`;

// Opus and Sonnet 5.5 run adaptive thinking when the field is omitted, so sending it changes nothing but the wire.
// Every Claude platform Geno reaches takes the 1 h TTL; OpenRouter's pass-through of it is untested. The thinking-off
// shapes, forced tool_choice and temperature follow the claude-api skill's per-model table (2026-10-06).
const CLAUDE_5_5 = { forcesTool: false, temperature: false, subagents: true } as const;
const CLAUDE_STRONG: Choices = { thinking: 'adaptive', thinkingOff: 'omit', ...CLAUDE_5_5, effort: true, promptTier: 'principles', cacheTtl: '1h', guessed: [] };
const CLAUDE_SONNET: Choices = { ...CLAUDE_STRONG, thinkingOff: 'between_tools', guessed: ['promptTier'] };
const CLAUDE_HAIKU: Choices = { thinking: 'omit', thinkingOff: 'disabled', forcesTool: true, temperature: true, subagents: true, effort: false, promptTier: 'rules', cacheTtl: '1h', guessed: [] };
// OpenRouter passes the request to Anthropic, so a row refuses what the model behind it refuses.
const OPENROUTER_CLAUDE: Choices = { thinking: 'omit', thinkingOff: 'omit', ...CLAUDE_5_5, effort: true, promptTier: 'principles', cacheTtl: '5m', guessed: ['effort'] };
// Model Studio has taken `output_config.effort` from qwen since U21 (docs/results/u21-effort.md).
const QWEN_FLASH: Choices = { thinking: 'omit', thinkingOff: 'disabled', forcesTool: true, temperature: true, subagents: false, effort: true, promptTier: 'rules', cacheTtl: '5m', guessed: [] };
// The larger qwen models were not in the P25 eval; they keep flash's measured default.
const QWEN_LARGER: Choices = { ...QWEN_FLASH, guessed: ['promptTier', 'subagents'] };

/**
 * Per provider and the model name it takes, as PRICES is keyed. Azure OpenAI has no rows: its model names are the
 * user's own deployment names. The OpenAI-compatible providers have none checked yet.
 */
export const MODEL_CAPABILITIES: { readonly [P in ProviderName]: Readonly<Record<string, ModelCapabilities>> } = {
  openrouter: {
    'anthropic/claude-opus-5.5': known(OPENROUTER_MODELS, 1_000_000, 128_000, OPENROUTER_CLAUDE),
    'anthropic/claude-sonnet-5.5': known(CLAUDE_DOCS, 1_000_000, 128_000, { ...OPENROUTER_CLAUDE, thinkingOff: 'between_tools', guessed: ['effort', 'promptTier'] }),
  },
  // Each page's "Context limits"; the output limits answered a live request at the limit and refused one above it.
  // Flash compacts at 200,000: a long session then costs about 30% of what it does at 800,000
  // (docs/results/p23-compaction-cost.md).
  modelstudio: {
    'qwen3.8-flash': known(modelStudioDocs('qwen3-8-flash'), 1_000_000, 131_072, QWEN_FLASH, 200_000),
    'qwen3.6-flash': known(modelStudioDocs('qwen3-6-flash'), 1_000_000, 65_536, QWEN_FLASH),
    'qwen3.7-plus': known(modelStudioDocs('qwen3-7-plus'), 1_000_000, 131_072, QWEN_LARGER),
    'qwen3.7-max': known(modelStudioDocs('qwen3-7-max'), 1_000_000, 131_072, QWEN_LARGER),
  },
  anthropic: {
    'claude-opus-5-5': known(CLAUDE_DOCS, 1_000_000, 128_000, CLAUDE_STRONG),
    'claude-sonnet-5-5': known(CLAUDE_DOCS, 1_000_000, 128_000, CLAUDE_SONNET),
    'claude-haiku-4-5': known(CLAUDE_DOCS, 200_000, 64_000, CLAUDE_HAIKU),
  },
  bedrock: {
    'anthropic.claude-opus-5-5': known(CLAUDE_DOCS, 1_000_000, 128_000, CLAUDE_STRONG),
    'anthropic.claude-sonnet-5-5': known(CLAUDE_DOCS, 1_000_000, 128_000, CLAUDE_SONNET),
  },
  vertex: {
    'claude-opus-5-5': known(CLAUDE_DOCS, 1_000_000, 128_000, CLAUDE_STRONG),
    'claude-sonnet-5-5': known(CLAUDE_DOCS, 1_000_000, 128_000, CLAUDE_SONNET),
  },
  openai: {},
  'azure-openai': {},
  gemini: {},
  deepseek: {},
  groq: {},
  cerebras: {},
  xai: {},
  mistral: {},
  ollama: {},
  lmstudio: {},
};

/**
 * A model with no row. With no window there is no clamp and no auto compaction; a provider that refuses a call as too
 * long still gets one. The output limit is the one Geno asked every model for before P23. Thinking off, a forced tool and a temperature
 * go out as they did before Claude 5.5, and the `agent` tool stays off by default, as it was for every model. No effort is sent, since a
 * model that does not take it refuses the whole request. The Chat Completions wire sends none of these fields, so the
 * provider's own defaults apply there.
 */
export const UNKNOWN_MODEL: ModelCapabilities = {
  window: undefined,
  maxOutput: 64_000,
  thinking: 'omit',
  thinkingOff: 'disabled',
  forcesTool: true,
  temperature: true,
  subagents: false,
  effort: false,
  promptTier: 'rules',
  cacheTtl: '5m',
  spillChars: SPILL_CHARS,
  compactAt: undefined,
  source: 'none: the request limit Geno sent every model before P23',
  guessed: ['effort', 'promptTier'],
};

export const capabilitiesOf = (provider: ProviderName, model: string): ModelCapabilities =>
  Object.hasOwn(MODEL_CAPABILITIES[provider], model) ? MODEL_CAPABILITIES[provider][model]! : UNKNOWN_MODEL;

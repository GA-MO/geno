/** What a redacted secret reads as. The same marker as the provider-key redactor's, so a log reads one way. */
export const REDACTED = '[redacted]';

const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)`;

/**
 * Each shape a secret takes in text the user did not mean to share, such as a terminal's output, and what it becomes.
 * Order matters: a private key block goes first, so no shape inside it is replaced on its own, and the specific token
 * shapes go before the generic `key=value` rule, which would otherwise keep only part of a quoted value.
 */
const RULES: readonly { readonly name: string; readonly pattern: RegExp; readonly replace: string }[] = [
  {
    name: 'private key block',
    pattern: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$(?![\s\S]))/g,
    replace: `-----BEGIN $1-----${REDACTED}-----END $1-----`,
  },
  { name: 'credentials in a URL', pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, replace: `$1:${REDACTED}@` },
  { name: 'OpenAI or Anthropic key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: REDACTED },
  { name: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { name: 'Slack token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: REDACTED },
  { name: 'Stripe key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: REDACTED },
  { name: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // A bearer token has a digit somewhere; "Bearer authentication" in prose does not.
  { name: 'bearer token', pattern: /\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/g, replace: `$1${REDACTED}` },
  { name: 'authorization header', pattern: /\b(Authorization:\s*(?:Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1${REDACTED}` },
  { name: 'secret flag', pattern: new RegExp(String.raw`(--${SECRET_KEY})(=|\s+)(?!-)("[^"]*"|'[^']*'|\S+)`, 'gi'), replace: `$1$2${REDACTED}` },
  {
    name: 'secret assignment',
    pattern: new RegExp(String.raw`(\b${SECRET_KEY}["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'&;,]+)`, 'gi'),
    replace: `$1${REDACTED}`,
  },
];

/**
 * `text` with each secret it holds replaced by REDACTED: API keys and tokens of common providers, authorization
 * headers, private key blocks, credentials in URLs and `password=`, `token:` or `--api-key` values. Running it again on
 * its own result changes nothing.
 */
export const redactSecrets = (text: string): string => RULES.reduce((out, rule) => out.replace(rule.pattern, rule.replace), text);

/** The settings page fixture, shared by the suite inside VS Code and the test that launches it. */

/** Typed into the page's key field; it must never show up in a file, a log or the page afterwards. */
export const OPENAI_KEY = 'sk-settings-canary-4c1d9e7b2a';

export const MODEL = 'gpt-fake';

export const PROMPT = 'Say hello through OpenAI.';
export const ANSWER = 'Hello from the OpenAI adapter.';

/** Environment the launcher gives the extension host, for the suite to check against. */
export const ENV = {
  /** The fake OpenAI-compatible server, which the user's own settings point at. */
  openaiUrl: 'SETTINGS_TEST_OPENAI_URL',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;

/** The turn end fixture, shared by the suite inside VS Code and the test that launches it. */

/** Each conversation carries its marker in its first message, so the fake model knows whose call it answers. */
export const MARKERS = { watched: '[watched]', away: '[away]' } as const;

export const PROMPTS = {
  watched: `${MARKERS.watched} Explain a.ts`,
  away: `${MARKERS.away} Explain a.ts while I am elsewhere`,
} as const;

/** The provider's message for the HTTP 400 the fake model answers every call with, which the gateway does not retry. */
export const BAD_REQUEST = 'messages.1.content.0: unexpected tool_use_id';

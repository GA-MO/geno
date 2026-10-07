/** The dev server preview fixture's prompt and texts, shared by the suite inside VS Code and the test that launches it. */
export const PROMPT = 'Start the app and check the home page';
export const ANSWER = 'The home page renders "Fake app", but it logs a hydration error and the server failed to load posts.';

/** What the fake dev server and its page log, from packages/engine/test/fixtures/fake-dev-server.mjs. */
export const SERVER_ERROR = 'Error: failed to load posts from the fake CMS';
export const CONSOLE_ERROR = 'Hydration failed: the fake page logs this on purpose';

/** The env var the launching test names the server's origin in. */
export const URL_ENV = 'GCODE_TEST_PREVIEW_URL';

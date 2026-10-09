import type { Look } from '../../src/chat/messages.js';
import type { FakeHost } from '../webview/host.js';

/**
 * A panel a fixture drives: the FakeHost on the extension's side, and the few things a user does in the page. The
 * gallery runs it in the browser beside each frame; the webview test runs it through Playwright.
 */
export type Stage = {
  readonly host: FakeHost;
  /** Waits until the panel shows `selector`. */
  shows(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  /** Puts `text` in the field `selector` and sends the input event typing would. */
  fill(selector: string, text: string): Promise<void>;
  /** Scrolls `selector` to the top of whatever scrolls it, once the panel drew the frames after it showed. */
  reveal(selector: string): Promise<void>;
};

/** One named state of the panel. Adding a state to the gallery and to its test is adding one of these. */
export type Fixture = {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  /** What the state needs of the look, such as full detail; the gallery's controls set the rest. */
  readonly look?: Partial<Look>;
  /** Whether the window has focus, which decides whether Noodle moves; true unless said. */
  readonly focused?: boolean;
  readonly play: (stage: Stage) => Promise<void>;
};

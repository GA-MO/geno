import { describe, expect, it } from 'vitest';
import {
  agentReducer,
  firstLink,
  linkLabel,
  parseCursorAbout,
  plainText,
  redact,
  shownOutput,
  type AgentEvent,
  type AgentState,
} from '../src/chat/agents-model.js';

/** `agent about` from Cursor CLI 2026.01.23-916f423, signed out, byte for byte as it printed with no terminal. */
const ABOUT_SIGNED_OUT =
  '\u001b[2K\u001b[GLoading...\n\u001b[2K\u001b[1A\u001b[2K\u001b[GAbout Cursor CLI\n\nCLI Version         2026.01.23-916f423\nModel               Auto\nOS                  darwin (arm64)\nTerminal            unknown\nShell               zsh\nUser Email          Not logged in\n';

/** The same recording with an account in the row; this machine has no signed-in recording. */
const ABOUT_SIGNED_IN = ABOUT_SIGNED_OUT.replace('Not logged in', 'user@example.com');

/** `agent status` from the same build, signed out. Geno reads `about` instead; this is why. */
const STATUS_SIGNED_OUT = ' Starting login process...\n\n\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[G Not logged in\n\n';

describe('reading the Cursor CLI', () => {
  it('reads the version and a signed-out account from `agent about`', () => {
    expect(parseCursorAbout(ABOUT_SIGNED_OUT)).toEqual({ version: '2026.01.23-916f423', signedIn: false });
  });

  it('reads the account a signed-in `agent about` names', () => {
    expect(parseCursorAbout(ABOUT_SIGNED_IN)).toEqual({ version: '2026.01.23-916f423', signedIn: true, account: 'user@example.com' });
  });

  it('knows nothing from output without the account row, such as `agent status`', () => {
    expect(parseCursorAbout(STATUS_SIGNED_OUT)).toBeUndefined();
    expect(parseCursorAbout('')).toBeUndefined();
  });

  it('drops the spinner’s terminal codes and keeps what a carriage return left', () => {
    expect(plainText('\u001b[2K\u001b[GLoading...\n\u001b[32mdone\u001b[0m\n')).toBe('Loading...\ndone\n');
    expect(plainText('10%\r50%\r100%\n')).toBe('100%\n');
  });
});

describe('what of a command’s output reaches the page', () => {
  it('takes out credentials and keeps the words around them', () => {
    const raw = [
      'token: abc123def456',
      'Authorization=Bearer-xyz',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here',
      'key sk-live-0123456789abcdefghij',
      'opaque 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end',
    ].join('\n');
    const shown = redact(raw);
    for (const secret of ['abc123def456', 'Bearer-xyz', 'eyJhbGci', 'sk-live', '9f86d081']) expect(shown).not.toContain(secret);
    expect(shown).toContain('token: [redacted]');
    expect(shown).toContain('here');
    expect(shown).toContain('end');
  });

  it('keeps ordinary output, paths and versions as they are', () => {
    const text = 'Updated Cursor Agent to 2026.10.01-1a2b3c4\nInstalled at /Users/me/.local/share/cursor-agent/versions/2026.10.01-1a2b3c4/cursor-agent\nSession ended. Login successful!';
    expect(redact(text)).toBe(text);
  });

  it('shows a sign-in address without its query, which can carry the login challenge', () => {
    const raw = 'Open https://cursor.com/loginDeepControl?challenge=Zm9vYmFy&uuid=1234-5678&mode=login to continue';
    expect(shownOutput(raw)).toBe('Open https://cursor.com/loginDeepControl?… to continue');
    expect(firstLink(raw)).toBe('https://cursor.com/loginDeepControl?challenge=Zm9vYmFy&uuid=1234-5678&mode=login');
    expect(linkLabel(firstLink(raw)!)).toBe('cursor.com');
  });

  it('finds no link where none was printed, and none that is not https', () => {
    expect(firstLink('Starting login process...')).toBeUndefined();
    expect(firstLink('see http://example.com/login')).toBeUndefined();
  });

  it('keeps only the end of a long output', () => {
    const shown = shownOutput(`${'line\n'.repeat(2000)}last`);
    expect(shown.startsWith('…')).toBe(true);
    expect(shown.endsWith('last')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(4001);
  });
});

const CLI = { path: '/Users/me/.local/bin/agent', version: '2026.01.23-916f423' };
const run = (state: AgentState, ...events: AgentEvent[]) => events.reduce(agentReducer, state);
const found = (signedIn: boolean): AgentEvent => ({
  type: 'checked',
  result: { kind: 'found', path: CLI.path, report: signedIn ? { version: CLI.version, signedIn: true, account: 'user@example.com' } : { version: CLI.version, signedIn: false } },
});

describe('an agent’s account state', () => {
  it('starts checking and settles on what the check found', () => {
    expect(run({ kind: 'checking' }, { type: 'checked', result: { kind: 'missing' } })).toEqual({ kind: 'missing' });
    expect(run({ kind: 'checking' }, found(false))).toEqual({ kind: 'signed-out', cli: CLI });
    expect(run({ kind: 'checking' }, found(true))).toEqual({ kind: 'signed-in', cli: CLI, account: 'user@example.com' });
    expect(run({ kind: 'checking' }, { type: 'checked', result: { kind: 'failed', path: CLI.path, text: 'timed out', output: '' } })).toEqual({
      kind: 'error',
      cli: { path: CLI.path, version: undefined },
      text: 'timed out',
      output: '',
    });
  });

  it('signs in: waits with the output and the link, then checks again and shows signed in', () => {
    const waiting = run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'login' }, { type: 'output', output: 'Opening the browser', link: 'cursor.com' }, { type: 'output', output: 'Opening the browser\nWaiting' });
    expect(waiting).toEqual({ kind: 'signing-in', cli: CLI, output: 'Opening the browser\nWaiting', link: 'cursor.com' });
    const ended = run(waiting, { type: 'exit', code: 0, cancelled: false });
    expect(ended).toEqual({ kind: 'checking', last: { ok: true, text: 'Sign-in finished.', output: 'Opening the browser\nWaiting' } });
    expect(run(ended, found(true))).toMatchObject({ kind: 'signed-in', last: { ok: true } });
  });

  it('reports a cancelled or failed sign-in under the signed-out account', () => {
    const waiting = run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'login' });
    expect(run(waiting, { type: 'exit', code: null, cancelled: true }, found(false))).toEqual({ kind: 'signed-out', cli: CLI, last: { ok: false, text: 'Sign-in cancelled.', output: '' } });
    expect(run(waiting, { type: 'output', output: 'no network' }, { type: 'exit', code: 1, cancelled: false }, found(false))).toEqual({
      kind: 'signed-out',
      cli: CLI,
      last: { ok: false, text: 'Sign-in failed (exit code 1).', output: 'no network' },
    });
  });

  it('updates from either account state and signs out only when signed in', () => {
    expect(run({ kind: 'signed-in', cli: CLI, account: undefined }, { type: 'start', action: 'update' })).toEqual({ kind: 'updating', cli: CLI, output: '' });
    expect(run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'update' })).toEqual({ kind: 'updating', cli: CLI, output: '' });
    expect(run({ kind: 'signed-in', cli: CLI, account: undefined }, { type: 'start', action: 'logout' })).toEqual({ kind: 'signing-out', cli: CLI, output: '' });
    const out: AgentState = { kind: 'signed-out', cli: CLI };
    expect(run(out, { type: 'start', action: 'logout' })).toBe(out);
    const signedIn: AgentState = { kind: 'signed-in', cli: CLI, account: undefined };
    expect(run(signedIn, { type: 'start', action: 'login' })).toBe(signedIn);
  });

  it('runs one command at a time and lets no check interrupt it', () => {
    const updating = run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'update' });
    expect(run(updating, { type: 'start', action: 'login' })).toBe(updating);
    expect(run(updating, { type: 'check' })).toBe(updating);
    expect(run(updating, found(true))).toBe(updating);
  });

  it('starts nothing where there is no CLI, and ignores a stray exit', () => {
    const missing: AgentState = { kind: 'missing' };
    expect(run(missing, { type: 'start', action: 'login' })).toBe(missing);
    const signedOut: AgentState = { kind: 'signed-out', cli: CLI };
    expect(run(signedOut, { type: 'exit', code: 0, cancelled: false })).toBe(signedOut);
    expect(run(signedOut, { type: 'output', output: 'x' })).toBe(signedOut);
  });
});

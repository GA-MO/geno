import { describe, expect, it } from 'vitest';
import {
  agentEnv,
  agentOf,
  agentReducer,
  checksOnFocus,
  copyText,
  EXTERNAL_AGENTS,
  firstLink,
  linkLabel,
  npmGlobalBins,
  offeredActions,
  parseClaudeAuthStatus,
  parseClaudeVersion,
  parseCursorAbout,
  plainText,
  redact,
  searchDirs,
  shownOutput,
  type AdapterFound,
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

const CLI = { path: '/Users/me/.local/bin/agent', version: '2026.01.23-916f423', adapter: { kind: 'built-in' } } as const;
const run = (state: AgentState, ...events: AgentEvent[]) => events.reduce(agentReducer, state);
const found = (signedIn: boolean, apiKey = false): AgentEvent => ({
  type: 'checked',
  result: { kind: 'found', path: CLI.path, adapter: CLI.adapter, apiKey, report: signedIn ? { version: CLI.version, signedIn: true, account: 'user@example.com' } : { version: CLI.version, signedIn: false } },
});
const browser = { kind: 'browser', account: 'user@example.com' } as const;

describe('an agent’s account state', () => {
  it('starts checking and settles on what the check found', () => {
    expect(run({ kind: 'checking' }, { type: 'checked', result: { kind: 'missing' } })).toEqual({ kind: 'missing' });
    expect(run({ kind: 'checking' }, found(false))).toEqual({ kind: 'signed-out', cli: CLI });
    expect(run({ kind: 'checking' }, found(true))).toEqual({ kind: 'signed-in', cli: CLI, auth: browser });
    expect(run({ kind: 'checking' }, { type: 'checked', result: { kind: 'failed', path: CLI.path, adapter: CLI.adapter, text: 'timed out', output: '' } })).toEqual({
      kind: 'error',
      cli: { path: CLI.path, version: undefined, adapter: CLI.adapter },
      text: 'timed out',
      output: '',
    });
  });

  it('reads a stored API key as signed in by key, whatever the browser login says, with no sign-out', () => {
    const keyed = run({ kind: 'checking' }, found(false, true));
    expect(keyed).toEqual({ kind: 'signed-in', cli: CLI, auth: { kind: 'api-key' } });
    expect(run({ kind: 'checking' }, found(true, true))).toEqual(keyed);
    expect(run(keyed, { type: 'start', action: 'logout' })).toBe(keyed);
    expect(run(keyed, { type: 'start', action: 'update' })).toEqual({ kind: 'updating', cli: CLI, output: '' });
  });

  it('signs in: waits with the output and the link, then checks again and shows signed in', () => {
    const waiting = run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'login' }, { type: 'output', output: 'Opening the browser', link: 'cursor.com' }, { type: 'output', output: 'Opening the browser\nWaiting' });
    expect(waiting).toEqual({ kind: 'signing-in', cli: CLI, output: 'Opening the browser\nWaiting', link: 'cursor.com' });
    const ended = run(waiting, { type: 'exit', code: 0, cancelled: false }, { type: 'check' });
    expect(ended).toEqual({ kind: 'checking', last: { ok: true, text: 'Sign-in finished.', output: 'Opening the browser\nWaiting' } });
    expect(run(ended, found(true))).toMatchObject({ kind: 'signed-in', last: { ok: true } });
  });

  it('reports a cancelled or failed sign-in under the signed-out account', () => {
    const waiting = run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'login' });
    expect(run(waiting, { type: 'exit', code: null, cancelled: true }, { type: 'check' }, found(false))).toEqual({ kind: 'signed-out', cli: CLI, last: { ok: false, text: 'Sign-in cancelled.', output: '' } });
    expect(run(waiting, { type: 'output', output: 'no network' }, { type: 'exit', code: 1, cancelled: false }, found(false))).toEqual({
      kind: 'signed-out',
      cli: CLI,
      last: { ok: false, text: 'Sign-in failed (exit code 1).', output: 'no network' },
    });
  });

  it('updates from either account state and signs out only when signed in by browser', () => {
    expect(run({ kind: 'signed-in', cli: CLI, auth: browser }, { type: 'start', action: 'update' })).toEqual({ kind: 'updating', cli: CLI, output: '' });
    expect(run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'update' })).toEqual({ kind: 'updating', cli: CLI, output: '' });
    expect(run({ kind: 'signed-in', cli: CLI, auth: browser }, { type: 'start', action: 'logout' })).toEqual({ kind: 'signing-out', cli: CLI, output: '' });
    const out: AgentState = { kind: 'signed-out', cli: CLI };
    expect(run(out, { type: 'start', action: 'logout' })).toBe(out);
    const signedIn: AgentState = { kind: 'signed-in', cli: CLI, auth: browser };
    expect(run(signedIn, { type: 'start', action: 'login' })).toBe(signedIn);
  });

  it('runs one command at a time and lets no check interrupt it', () => {
    const updating = run({ kind: 'signed-out', cli: CLI }, { type: 'start', action: 'update' });
    expect(run(updating, { type: 'start', action: 'login' })).toBe(updating);
    expect(run(updating, { type: 'check' })).toBe(updating);
    expect(run(updating, found(true))).toBe(updating);
  });

  it('starts nothing where there is no CLI, checks again from missing, and ignores a stray exit', () => {
    const missing: AgentState = { kind: 'missing' };
    expect(run(missing, { type: 'start', action: 'login' })).toBe(missing);
    expect(run(missing, { type: 'check' }, found(false))).toEqual({ kind: 'signed-out', cli: CLI });
    const signedOut: AgentState = { kind: 'signed-out', cli: CLI };
    expect(run(signedOut, { type: 'exit', code: 0, cancelled: false })).toBe(signedOut);
    expect(run(signedOut, { type: 'output', output: 'x' })).toBe(signedOut);
  });
});

describe('the env of the CLI’s processes', () => {
  const cursor = EXTERNAL_AGENTS[0]!;

  it('carries a stored key as CURSOR_API_KEY, beside what the process needs anyway', () => {
    expect(agentEnv(cursor, { PATH: '/bin' }, 'crsr-key', { NO_OPEN_BROWSER: '1' })).toEqual({ PATH: '/bin', NO_OPEN_BROWSER: '1', CURSOR_API_KEY: 'crsr-key' });
  });

  it('adds no key when none is stored, and leaves the base env as it was', () => {
    const base = { PATH: '/bin' };
    expect(agentEnv(cursor, base, undefined)).toEqual({ PATH: '/bin' });
    agentEnv(cursor, base, 'crsr-key');
    expect(base).toEqual({ PATH: '/bin' });
  });
});

/** `claude auth status --json` from Claude Code 2.1.291, signed in, with the account and ids replaced. */
const CLAUDE_SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  analyticsDisabled: false,
  projectsDirectory: '/Users/me/.claude/projects',
  configDirectory: '/Users/me/.claude',
  email: 'user@example.com',
  orgId: '00000000-0000-0000-0000-000000000000',
  orgName: 'Example',
  subscriptionType: 'max',
});

describe('reading Claude Code', () => {
  const claude = agentOf('claude-code')!;
  const cursor = agentOf('cursor')!;

  it('reads a signed-in account and its plan from `claude auth status --json`', () => {
    expect(parseClaudeAuthStatus(CLAUDE_SIGNED_IN)).toEqual({ version: undefined, signedIn: true, account: 'user@example.com', plan: 'max' });
  });

  it('reads `loggedIn: false` as signed out', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }))).toEqual({ version: undefined, signedIn: false });
  });

  it('knows nothing from output that is not that object, which the card shows as an error', () => {
    for (const garbage of ['', 'Not logged in', '{"loggedIn": "yes"}', '[]', 'null', '{"email": "user@example.com"}', '{loggedIn: true']) expect(parseClaudeAuthStatus(garbage)).toBeUndefined();
    const failed: AgentEvent = { type: 'checked', result: { kind: 'failed', path: '/bin/claude', adapter: { kind: 'missing' }, text: 'unreadable', output: 'Not logged in' } };
    expect(run({ kind: 'checking' }, failed)).toMatchObject({ kind: 'error', text: 'unreadable' });
  });

  it('reads the version `claude --version` prints', () => {
    expect(parseClaudeVersion('2.1.291 (Claude Code)\n')).toBe('2.1.291');
    expect(parseClaudeVersion('command not found')).toBeUndefined();
  });

  it('shows sign-in and sign-out as commands to copy, and runs only Update', () => {
    const cli = { path: '/Users/me/.local/bin/claude', version: '2.1.291', adapter: { kind: 'missing' } } as const;
    const ways = (state: AgentState) => offeredActions(claude, state).map(([action, way]) => `${action}:${way.kind}`);
    expect(ways({ kind: 'signed-out', cli })).toEqual(['login:copy', 'update:run']);
    expect(ways({ kind: 'signed-in', cli, auth: { kind: 'browser', account: 'user@example.com' } })).toEqual(['logout:copy', 'update:run']);
    expect(ways({ kind: 'signed-in', cli, auth: { kind: 'api-key' } })).toEqual(['update:run']);
    expect(copyText(claude, 'login')).toBe('claude auth login');
    expect(copyText(claude, 'logout')).toBe('claude auth logout');
    expect(copyText(claude, 'update')).toBeUndefined();
    expect(copyText(claude, 'install')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(copyText(claude, 'adapter')).toBe('npm install -g @agentclientprotocol/claude-agent-acp');
    expect(offeredActions(cursor, { kind: 'signed-out', cli: CLI }).every(([, way]) => way.kind === 'run')).toBe(true);
    expect(copyText(cursor, 'login')).toBeUndefined();
    expect(copyText(cursor, 'adapter')).toBeUndefined();
  });

  it('carries the adapter it found, or that it is missing, into the state', () => {
    const at = (adapter: AdapterFound): AgentEvent => ({ type: 'checked', result: { kind: 'found', path: '/bin/claude', adapter, apiKey: false, report: { version: '2.1.291', signedIn: false } } });
    expect(run({ kind: 'checking' }, at({ kind: 'missing' }))).toEqual({ kind: 'signed-out', cli: { path: '/bin/claude', version: '2.1.291', adapter: { kind: 'missing' } } });
    expect(run({ kind: 'checking' }, at({ kind: 'found', path: '/bin/claude-agent-acp' }))).toEqual({
      kind: 'signed-out',
      cli: { path: '/bin/claude', version: '2.1.291', adapter: { kind: 'found', path: '/bin/claude-agent-acp' } },
    });
    const signedIn: AgentEvent = { type: 'checked', result: { kind: 'found', path: '/bin/claude', adapter: { kind: 'missing' }, apiKey: false, report: { version: undefined, signedIn: true, account: 'user@example.com', plan: 'max' } } };
    expect(run({ kind: 'checking' }, signedIn)).toMatchObject({ auth: { kind: 'browser', account: 'user@example.com', plan: 'max' } });
  });

  it('looks again on focus only where the user went to a terminal: missing, a command to copy, or no adapter', () => {
    const found = { path: '/bin/claude', version: '2.1.291', adapter: { kind: 'found', path: '/bin/claude-agent-acp' } } as const;
    const keyed: AgentState = { kind: 'signed-in', cli: found, auth: { kind: 'api-key' } };
    expect(checksOnFocus(claude, { kind: 'missing' })).toBe(true);
    expect(checksOnFocus(claude, { kind: 'signed-out', cli: found })).toBe(true);
    expect(checksOnFocus(claude, keyed)).toBe(false);
    expect(checksOnFocus(claude, { ...keyed, cli: { ...found, adapter: { kind: 'missing' } } })).toBe(true);
    expect(checksOnFocus(claude, { kind: 'updating', cli: found, output: '' })).toBe(false);
    expect(checksOnFocus(cursor, { kind: 'signed-out', cli: CLI })).toBe(false);
  });

  it('carries a stored key as ANTHROPIC_API_KEY, and none without one', () => {
    expect(agentEnv(claude, { PATH: '/bin' }, 'sk-ant-key', claude.statusEnv)).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-key' });
    expect(agentEnv(claude, { PATH: '/bin' }, undefined, claude.statusEnv)).toEqual({ PATH: '/bin' });
  });

  it('looks for the CLI and its adapter in ~/.local/bin and npm’s global bin folders, without running npm', () => {
    expect(searchDirs(claude, { NPM_CONFIG_PREFIX: '/opt/npm', NVM_BIN: '/Users/me/.nvm/versions/node/v22/bin' }, '/Users/me', '/usr/local/bin')).toEqual([
      '/Users/me/.local/bin',
      '/opt/npm/bin',
      '/Users/me/.nvm/versions/node/v22/bin',
      '/Users/me/.npm-global/bin',
      '/usr/local/bin',
    ]);
    expect(npmGlobalBins({ npm_config_prefix: '/p', NPM_CONFIG_PREFIX: '/p' }, '/h', undefined)).toEqual(['/p/bin', '/h/.npm-global/bin']);
    expect(searchDirs(cursor, { NPM_CONFIG_PREFIX: '/opt/npm' }, '/Users/me', '/usr/local/bin')).toEqual(['/Users/me/.local/bin']);
  });
});

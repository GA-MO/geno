/** The Agents section fixture, shared by the suite inside VS Code and the test that writes the fake Cursor CLI. */

export const FAKE = {
  version: '2026.01.23-916f423',
  updated: '2026.10.01-fake',
  account: 'fake.user@example.com',
  host: 'cursor.example',
  /** Printed in the sign-in address's query and as a token line; neither may reach the page. */
  challenge: 'challenge-canary-7f3a9c',
  token: 'tok-canary-b81e44d0',
  /** The API key the suite types in; it may reach only the fake's env. */
  key: 'crsr-key-canary-3e9a71c2',
} as const;

/** The fake Claude Code's values: its version before and after Update, its account, and the key the suite types in. */
export const CLAUDE = {
  version: '2.1.291',
  updated: '2.1.300',
  account: 'claude.user@example.com',
  plan: 'max',
  key: 'sk-ant-key-canary-5d20b7e1',
} as const;

/** What `claude auth status --json` prints, signed out and signed in, in Claude Code 2.1.291's shape. */
export const claudeStatus = (signedIn: boolean): string =>
  JSON.stringify(
    signedIn
      ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', analyticsDisabled: false, email: CLAUDE.account, orgName: 'Example', subscriptionType: CLAUDE.plan }
      : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', analyticsDisabled: false },
    null,
    2,
  );

/**
 * A stand-in for Claude Code. `--version` and `auth status --json` print files the suite writes, `update` bumps the
 * version, and every call is logged with its arguments and whether an API key was in its env, never the key.
 */
export function fakeClaudeScript(state: string): string {
  return `#!/bin/sh
S='${state}'
echo "$* key=\${ANTHROPIC_API_KEY:+present}" >> "$S/claude-calls.log"
[ "\${ANTHROPIC_API_KEY:-}" = '${CLAUDE.key}' ] && echo "$*" >> "$S/claude-keyed.log"
case "$1 $2" in
  '--version ')
    printf '%s (Claude Code)\\n' "$(cat "$S/claude-version")"
    ;;
  'auth status')
    cat "$S/claude-status.json"
    ;;
  'update ')
    echo 'Checking for updates...'
    sleep 1
    printf '%s' '${CLAUDE.updated}' > "$S/claude-version"
    echo 'Successfully updated to ${CLAUDE.updated}'
    ;;
  *)
    echo "unknown command $*" >&2
    exit 2
    ;;
esac
`;
}

/** A stand-in for the ACP adapter, which the card only looks for: it records that it ran, which it never should. */
export const fakeAdapterScript = (state: string): string => `#!/bin/sh\necho "$*" >> '${state}/adapter.log'\n`;

/** Environment the launcher gives the extension host. */
export const ENV = {
  /** The folder first on PATH, where the fake `agent` appears once the suite installs it. */
  bin: 'AGENTS_TEST_BIN',
  /** The fake's own state: its account, version, a log of its calls, and the file that ends a sign-in. */
  state: 'AGENTS_TEST_STATE',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;

/**
 * A stand-in for the Cursor CLI. `about` prints the recorded table of the real one, `login` prints an address and
 * waits for `go`, and every call is logged with its arguments, whether NO_OPEN_BROWSER was set, and whether an API
 * key was in its env. It logs the key's presence, never the key.
 */
export function fakeAgentScript(state: string): string {
  return `#!/bin/sh
S='${state}'
echo "$* NO_OPEN_BROWSER=\${NO_OPEN_BROWSER:-} key=\${CURSOR_API_KEY:+present}" >> "$S/calls.log"
[ "\${CURSOR_API_KEY:-}" = '${FAKE.key}' ] && echo "$1" >> "$S/keyed.log"
version=$(cat "$S/version")
case "$1" in
  about)
    email=$(cat "$S/email" 2>/dev/null || echo 'Not logged in')
    printf '\\033[2K\\033[GLoading...\\n\\033[2K\\033[1A\\033[2K\\033[GAbout Cursor CLI\\n\\nCLI Version         %s\\nModel               Auto\\nOS                  darwin (arm64)\\nTerminal            unknown\\nShell               zsh\\nUser Email          %s\\n' "$version" "$email"
    ;;
  login)
    echo 'Starting login process...'
    echo 'Open this page to sign in: https://${FAKE.host}/loginDeepControl?challenge=${FAKE.challenge}&uuid=1234&mode=login'
    echo 'token: ${FAKE.token}'
    while [ ! -f "$S/go" ]; do sleep 0.2; done
    rm -f "$S/go"
    printf '%s' '${FAKE.account}' > "$S/email"
    echo 'Login successful!'
    ;;
  logout)
    rm -f "$S/email"
    echo 'Logged out successfully'
    ;;
  update)
    echo 'Checking for updates...'
    sleep 1
    printf '%s' '${FAKE.updated}' > "$S/version"
    echo 'Updated to ${FAKE.updated}'
    ;;
  *)
    echo "unknown command $1" >&2
    exit 2
    ;;
esac
`;
}

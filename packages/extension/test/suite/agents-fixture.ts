/** The Agents section fixture, shared by the suite inside VS Code and the test that writes the fake Cursor CLI. */

export const FAKE = {
  version: '2026.01.23-916f423',
  updated: '2026.10.01-fake',
  account: 'fake.user@example.com',
  host: 'cursor.example',
  /** Printed in the sign-in address's query and as a token line; neither may reach the page. */
  challenge: 'challenge-canary-7f3a9c',
  token: 'tok-canary-b81e44d0',
} as const;

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
 * waits for `go`, and every call is logged with whether NO_OPEN_BROWSER was set.
 */
export function fakeAgentScript(state: string): string {
  return `#!/bin/sh
S='${state}'
echo "$* NO_OPEN_BROWSER=\${NO_OPEN_BROWSER:-}" >> "$S/calls.log"
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

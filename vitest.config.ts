import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const VSCODE_TESTS = 'packages/extension/test/**/*.integration.test.ts';

export default defineConfig({
  test: {
    // Engine e2e tests open the sandbox, which allows one per process; a test abandoned at a short timeout
    // under machine load leaves it open and fails every later test in the file.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['packages/*/test/**/*.test.ts'], exclude: [VSCODE_TESTS], sequence: { groupOrder: 0 } },
      },
      {
        // Each file launches a whole VS Code; several at once starve the machine and time out, so they run one at a time after the rest.
        extends: true,
        test: {
          name: 'vscode',
          include: [VSCODE_TESTS],
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
          // VS Code and the engine inherit this, so the Claude Code plugins installed on the machine stay out of the tests' command lists.
          env: { CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'gcode-tests-no-claude-config') },
        },
      },
    ],
  },
});

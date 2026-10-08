import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { useTestLock } from './scripts/test-lock.js';
import { useTestTmp } from './scripts/test-tmp.js';
import { vscodeWorkers } from './scripts/vscode-workers.js';

useTestTmp();
useTestLock();

const VSCODE_TESTS = 'packages/extension/test/**/*.integration.test.ts';
const WEBVIEW_TESTS = 'packages/extension/test/**/*.webview.test.ts';
// Each file runs in one of this many pooled VS Code windows (vscode-setup.ts), so it is also how many run at once.
const workers = vscodeWorkers(process.env);
// Unit and webview files each take a worker; every core at once left no room for the editor or a second checkout.
const unitWorkers = Number(process.env['GCODE_TEST_WORKERS'] ?? 4);

export default defineConfig({
  test: {
    // Engine e2e tests run sandboxed commands, which are slow under machine load.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', maxWorkers: unitWorkers, include: ['packages/*/test/**/*.test.ts', 'scripts/**/*.test.ts'], exclude: [VSCODE_TESTS, WEBVIEW_TESTS], sequence: { groupOrder: 0 } },
      },
      // The chat webview in headless Chromium against a fake host: no VS Code, so these run in parallel with the unit tests.
      { extends: true, test: { name: 'webview', maxWorkers: unitWorkers, include: [WEBVIEW_TESTS], sequence: { groupOrder: 0 } } },
      {
        // Each file leases a VS Code window from the pool and runs its suite there in a fresh workspace, extension host and engine.
        extends: true,
        test: {
          name: 'vscode',
          include: [VSCODE_TESTS],
          fileParallelism: workers > 1,
          maxWorkers: workers,
          sequence: { groupOrder: 1 },
          globalSetup: ['packages/extension/test/vscode-setup.ts'],
          // VS Code and the engine inherit this, so the Claude Code plugins installed on the machine stay out of the tests' command lists.
          env: { CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'gcode-tests-no-claude-config') },
        },
      },
    ],
  },
});

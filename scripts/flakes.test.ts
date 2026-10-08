import { describe, expect, it } from 'vitest';
import { failedFiles, flakesOf, type Report } from './flakes.js';

const file = (name: string, status: 'passed' | 'failed', failure?: string): Report['testResults'][number] => ({
  name: `/repo/packages/extension/test/${name}.integration.test.ts`,
  status,
  assertionResults: [{ fullName: `${name} works`, status, failureMessages: failure === undefined ? [] : [`${failure}\n    at run (suite.js:1:1)`] }],
});

describe('flakesOf', () => {
  const first: Report = { testResults: [file('waits', 'failed', 'Error: timed out waiting for the chat'), file('chat', 'passed'), file('start', 'failed', 'Error: Noodle never flipped')] };

  it('lists the failed files to retry', () => {
    expect(failedFiles(first).map((f) => f.replace(/.*\//, ''))).toEqual(['waits.integration.test.ts', 'start.integration.test.ts']);
  });

  it('calls a file flaky only when it passed on its retry, with its first failure', () => {
    const retry: Report = { testResults: [file('waits', 'passed'), file('start', 'failed', 'Error: Noodle never flipped')] };
    expect(flakesOf(first, retry)).toEqual([{ file: first.testResults[0]!.name, test: 'waits works', firstFailure: 'Error: timed out waiting for the chat' }]);
  });

  it('finds no flakes when everything passed the first time', () => {
    const clean: Report = { testResults: [file('chat', 'passed')] };
    expect(flakesOf(clean, { testResults: [] })).toEqual([]);
    expect(failedFiles(clean)).toEqual([]);
  });
});

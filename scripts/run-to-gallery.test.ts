import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { OUTPUT, realSessions, renderRealSessions } from './run-to-gallery.js';

it('the gallery’s real sessions are what the engine’s replay and the panel’s update mapping make of the archived runs', () => {
  const sessions = realSessions();
  expect(readFileSync(OUTPUT, 'utf8'), 'the mapping changed: run pnpm tsx scripts/run-to-gallery.ts and review the diff').toBe(renderRealSessions(sessions));
  const card = sessions.find((s) => s.id === 'real-approval')!.actions.at(-1);
  expect(card).toMatchObject({ type: 'permission', command: 'rm -rf build', rule: 'rm -rf build' });
  expect(sessions.find((s) => s.id === 'real-subagent')!.actions.map((a) => a.type)).toContain('child-start');
});

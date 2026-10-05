import { describe, expect, it } from 'vitest';
import type { Block, PermissionBlock, ToolBlock, ToolKind, ToolStatus, Turn } from '../src/chat/messages.js';
import { framesOf, playhead, POSES, type PoseName } from '../src/chat/sprite.js';
import { checksPassed, endingOf, HOLD_TICKS, steer, WORK_POSES, workOf, type Working } from '../src/chat/working.js';

const tool = (id: string, name: string, target: string, status: ToolStatus, over: Partial<ToolBlock> = {}): ToolBlock => {
  const kinds: Record<string, ToolKind> = { read: 'read', grep: 'search', glob: 'search', list: 'search', edit: 'edit', bash: 'execute', check: 'execute' };
  return { kind: 'tool', id, name, target, toolKind: kinds[name] ?? 'other', status, startedAt: 0, endedAt: status === 'running' ? undefined : 1, output: undefined, diff: undefined, ...over };
};

const asking: PermissionBlock = { kind: 'permission', id: 'p1', command: 'rm -rf build', reason: 'rm', options: [], outcome: { kind: 'open' } };

const turn = (blocks: readonly Block[], over: Partial<Turn> = {}): Turn => ({
  id: 't1',
  prompt: 'go',
  blocks,
  status: 'streaming',
  startedAt: 0,
  endedAt: undefined,
  usage: undefined,
  ...over,
});

const poseOf = (blocks: readonly Block[], over: Partial<Turn> = {}): PoseName => WORK_POSES[workOf(turn(blocks, over))];

describe('the working dino: which pose the running turn shows', () => {
  it('maps every kind of work to the brief’s pose, one row each', () => {
    expect(WORK_POSES).toEqual({
      thinking: 'thinking',
      read: 'reading',
      code: 'coding',
      write: 'writing',
      run: 'running',
      plan: 'planning',
      ask: 'asking',
      failed: 'sweat',
    });
  });

  it('thinks while the model works with no tool running', () => {
    expect(poseOf([])).toBe('thinking');
    expect(poseOf([tool('a', 'read', 'a.ts', 'completed')])).toBe('thinking');
    expect(poseOf([{ kind: 'text', id: 'x', text: 'Looking.' }])).toBe('thinking');
  });

  it('reads for read, grep, glob, list and skill', () => {
    for (const name of ['read', 'grep', 'glob', 'list', 'skill']) expect(poseOf([tool('a', name, 'x', 'running')]), name).toBe('reading');
  });

  it('codes for an edit of a code file, and writes for an edit of anything else', () => {
    for (const file of ['src/app.ts', 'App.tsx', 'main.py', 'lib.rs', 'run.sh', 'site.css']) expect(poseOf([tool('a', 'edit', file, 'running')]), file).toBe('coding');
    for (const file of ['README.md', 'package.json', 'config.yaml', 'notes.txt', '.env', 'Dockerfile']) expect(poseOf([tool('a', 'edit', file, 'running')]), file).toBe('writing');
  });

  it('runs in place for bash, check and MCP calls', () => {
    for (const name of ['bash', 'check', 'mcp__github__list_issues']) expect(poseOf([tool('a', name, '', 'running')]), name).toBe('running');
  });

  it('follows the call under way, not an earlier one', () => {
    expect(poseOf([tool('a', 'read', 'a.ts', 'completed'), tool('b', 'edit', 'a.ts', 'running')])).toBe('coding');
  });

  it('asks while a card waits, above everything else', () => {
    expect(poseOf([tool('a', 'bash', 'rm -rf build', 'running'), asking])).toBe('asking');
    expect(poseOf([asking], { mode: 'plan' })).toBe('asking');
  });

  it('sweats after a failed step, until the next call starts', () => {
    expect(poseOf([tool('a', 'read', 'missing.ts', 'failed')])).toBe('sweat');
    expect(poseOf([tool('a', 'read', 'missing.ts', 'failed'), { kind: 'text', id: 'x', text: 'Not there.' }])).toBe('sweat');
    expect(poseOf([tool('a', 'read', 'missing.ts', 'failed'), tool('b', 'read', 'b.ts', 'running')])).toBe('reading');
  });

  it('plans with the clipboard through a Plan turn, but still asks and sweats', () => {
    expect(poseOf([], { mode: 'plan' })).toBe('planning');
    expect(poseOf([tool('a', 'read', 'a.ts', 'running')], { mode: 'plan' })).toBe('planning');
    expect(poseOf([tool('a', 'read', 'missing.ts', 'failed')], { mode: 'plan' })).toBe('sweat');
  });
});

const passed = (id: string) => tool(id, 'check', '', 'completed', { output: 'check `pnpm test` passed' });
const failed = (id: string) => tool(id, 'check', '', 'completed', { output: 'check `pnpm test` failed (exit 1)\nerror TS2322' });

describe('the turn end', () => {
  it('reads whether the turn’s checks passed: the last check decides, an edit’s own check counts, and no check is no answer', () => {
    expect(checksPassed(turn([passed('a')]))).toBe(true);
    expect(checksPassed(turn([failed('a')]))).toBe(false);
    expect(checksPassed(turn([failed('a'), passed('b')]))).toBe(true);
    expect(checksPassed(turn([passed('a'), failed('b')]))).toBe(false);
    expect(checksPassed(turn([tool('a', 'edit', 'a.ts', 'completed', { output: 'edited a.ts\ncheck `tsc` passed' })]))).toBe(true);
    expect(checksPassed(turn([tool('a', 'check', '', 'completed', { output: 'The editor reports no problems in the files you read or edited.' })]))).toBe(true);
    expect(checksPassed(turn([tool('a', 'check', '', 'completed', { output: 'The editor reports these problems in the files you read or edited:\na.ts:1:1 error: x' })]))).toBe(false);
    expect(checksPassed(turn([tool('a', 'check', '', 'completed', { output: 'This workspace has no check command. Run its tests or type checker with bash instead.' })]))).toBeUndefined();
    expect(checksPassed(turn([tool('a', 'bash', 'echo "check `x` passed"', 'completed', { output: 'check `x` passed\n[exit code 0]' })]))).toBeUndefined();
    expect(checksPassed(turn([tool('a', 'read', 'a.ts', 'completed')]))).toBeUndefined();
  });

  it('flexes only when the turn is done and its checks passed', () => {
    const done = { status: 'done' as const, endedAt: 2 };
    expect(endingOf(turn([passed('a')], done), () => 0)).toBe('flex');
    expect(endingOf(turn([passed('a')], done), () => 0.99)).toBe('flex');
    for (const blocks of [[], [failed('a')]]) {
      expect(endingOf(turn(blocks, done), () => 0)).toBe('hop');
      expect(endingOf(turn(blocks, done), () => 0.99)).toBe('somersault');
    }
  });

  it('plays no move for a turn that was stopped or failed', () => {
    expect(endingOf(turn([passed('a')], { status: 'stopped', endedAt: 2 }), () => 0)).toBeUndefined();
    expect(endingOf(turn([passed('a')], { status: 'failed', endedAt: 2 }), () => 0)).toBeUndefined();
  });
});

const ticks = (working: Working, n: number): Working => ({ ...working, t: working.t + n });
const lengthOf = (pose: PoseName): number => framesOf(POSES[pose]).reduce((sum, frame) => sum + (frame.hold ?? 1), 0);

describe('the working dino over a turn', () => {
  const at = (blocks: readonly Block[], over: Partial<Turn> = {}) => turn(blocks, over);
  const never = () => 0;

  it('starts with the running turn, and never for a finished turn it did not watch', () => {
    expect(steer(undefined, at([]), false, never)?.pose).toBe('thinking');
    expect(steer(undefined, at([passed('a')], { status: 'done', endedAt: 2 }), false, never)).toBeUndefined();
    expect(steer(undefined, undefined, false, never)).toBeUndefined();
  });

  it('switches to a new kind of work at once, and back to thinking only after the pose plays through', () => {
    const reading = steer(steer(undefined, at([]), false, never), at([tool('a', 'read', 'a.ts', 'running')]), false, never)!;
    expect(reading.pose).toBe('reading');
    const after = at([tool('a', 'read', 'a.ts', 'completed')]);
    expect(steer(ticks(reading, 3), after, false, never)!.pose).toBe('reading');
    expect(steer(ticks(reading, lengthOf('reading')), after, false, never)!.pose).toBe('thinking');
    expect(steer(ticks(reading, 3), at([tool('a', 'read', 'a.ts', 'completed'), tool('b', 'bash', 'ls', 'running')]), false, never)!.pose).toBe('running');
  });

  it('holds a short pose, such as running in place, long enough to see before thinking', () => {
    const running = steer(undefined, at([tool('a', 'bash', 'ls', 'running')]), false, never)!;
    const after = at([tool('a', 'bash', 'ls', 'completed')]);
    expect(steer(ticks(running, lengthOf('running')), after, false, never)!.pose).toBe('running');
    expect(steer(ticks(running, HOLD_TICKS - 1), after, false, never)!.pose).toBe('running');
    expect(steer(ticks(running, HOLD_TICKS), after, false, never)!.pose).toBe('thinking');
  });

  it('thinks at once when frames do not play, under reduced motion or high contrast', () => {
    const reading = steer(undefined, at([tool('a', 'read', 'a.ts', 'running')]), true, never)!;
    expect(steer(reading, at([tool('a', 'read', 'a.ts', 'completed')]), true, never)!.pose).toBe('thinking');
  });

  it('pulls the laptop out once a turn: the second edit of code goes straight to typing', () => {
    const first = steer(undefined, at([tool('a', 'edit', 'a.ts', 'running')]), false, never)!;
    expect([first.pose, first.intro]).toEqual(['coding', true]);
    const between = steer(first, at([tool('a', 'edit', 'a.ts', 'completed'), tool('b', 'bash', 'ls', 'running')]), false, never)!;
    const again = steer(between, at([tool('a', 'edit', 'a.ts', 'completed'), tool('b', 'bash', 'ls', 'completed'), tool('c', 'edit', 'b.ts', 'running')]), false, never)!;
    expect([again.pose, again.intro]).toEqual(['coding', false]);
    expect(steer(again, at([tool('d', 'edit', 'c.ts', 'running')], { id: 't2' }), false, never)!.intro).toBe(true);
  });

  it('plays the turn-end move once, then leaves the still avatar', () => {
    const working = steer(undefined, at([passed('a')]), false, never)!;
    const ended = at([passed('a')], { status: 'done', endedAt: 2 });
    const flexing = steer(working, ended, false, never)!;
    expect(flexing.pose).toBe('flex');
    expect(steer(ticks(flexing, 2), ended, false, never)!.pose).toBe('flex');
    expect(steer(ticks(flexing, lengthOf('flex')), ended, false, never)).toBeUndefined();
  });

  it('skips the turn-end move when frames do not play, and for a stopped turn', () => {
    const working = steer(undefined, at([passed('a')]), false, never)!;
    expect(steer(working, at([passed('a')], { status: 'done', endedAt: 2 }), true, never)).toBeUndefined();
    expect(steer(working, at([passed('a')], { status: 'stopped', endedAt: 2 }), false, never)).toBeUndefined();
  });

  it('plays its intro once, then loops; a once pose holds its last frame and says it ended', () => {
    const coding = POSES.coding;
    expect(playhead(coding, 0, true).frame).toBe(coding.intro![0]);
    expect(playhead(coding, 0, false).frame).toBe(coding.loop[0]);
    const intro = coding.intro!.reduce((sum, frame) => sum + (frame.hold ?? 1), 0);
    const loop = coding.loop.reduce((sum, frame) => sum + (frame.hold ?? 1), 0);
    expect(playhead(coding, intro, true).frame).toBe(coding.loop[0]);
    expect(playhead(coding, intro + loop, true).frame).toBe(coding.loop[0]);
    expect(playhead(coding, intro + loop - 1, true).cycled).toBe(false);
    expect(playhead(coding, intro + loop, true).cycled).toBe(true);
    expect(playhead(POSES.flex, 0, true).ended).toBe(false);
    expect(playhead(POSES.flex, lengthOf('flex') + 5, true)).toEqual({ frame: POSES.flex.loop.at(-1), cycled: true, ended: true });
    expect(playhead(POSES.reading, lengthOf('reading') * 3, true).ended).toBe(false);
  });
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STOP_GRACE_MS, type JobView } from '@g-code/core';
import { BackgroundJobs, type JobEnd } from '../src/background.js';
import { spawnShell } from '../src/process.js';

/** The jobs with no sandbox around their commands, recording what they told their hooks. */
function jobs() {
  const views: JobView[] = [];
  const ends: JobEnd[] = [];
  let held = 0;
  const registry = new BackgroundJobs({ changed: (_job, view) => views.push(view), ended: (end) => ends.push(end) });
  const sandbox = {
    spawn: spawnShell,
    retain: () => {
      held++;
      return async () => void held--;
    },
  };
  const start = async (sessionId: string, command: string, cwd: string) =>
    registry.start({ sessionId, toolUseId: `tu_${command}`, command, cwd, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, spillDir: await mkdtemp(path.join(tmpdir(), 'gcode-spill-')), events: [], sandbox });
  return { registry, views, ends, start, held: () => held };
}

describe('background jobs', () => {
  it('holds the sandbox while a job runs and lets go once it ends', async () => {
    const { registry, start, held, ends } = jobs();
    const cwd = tmpdir();
    await start('s1', 'sleep 0.2; echo ok', cwd);
    expect(held()).toBe(1);
    await registry.settled();
    expect(held()).toBe(0);
    expect(ends).toEqual([expect.objectContaining({ job: expect.objectContaining({ id: 'bg-1', state: { status: 'exited', exitCode: 0, signal: null } }), tail: 'ok' })]);
  });

  it('kills a command that ignores SIGTERM once the grace period is over', async () => {
    const { registry, start } = jobs();
    await start('s1', "trap '' TERM; echo ready; while true; do sleep 0.1; done", tmpdir());
    while (!registry.output('s1', 'bg-1', 1).endsWith('ready')) await new Promise((resolve) => setTimeout(resolve, 20));
    const began = Date.now();
    const stopped = await registry.stop('s1', 'bg-1', 'model');
    expect(stopped.state).toEqual({ status: 'stopped', by: 'model' });
    expect(Date.now() - began).toBeGreaterThanOrEqual(STOP_GRACE_MS - 50);
  }, STOP_GRACE_MS + 5000);

  it("kills the jobs that run in a discarded lane's folder and leaves the others", async () => {
    const { registry, start } = jobs();
    const lane = await mkdtemp(path.join(tmpdir(), 'gcode-lane-'));
    await start('lane-session', 'sleep 30', lane);
    await start('main-session', 'sleep 30', tmpdir());
    await registry.kill('lane-discarded', { cwd: lane });
    expect(registry.views('lane-session').map((view) => view.state)).toEqual([{ status: 'killed', cause: 'lane-discarded' }]);
    expect(registry.views('main-session').map((view) => view.state.status)).toEqual(['running']);
    await registry.kill('engine-exit', 'all');
    expect(registry.views('main-session').map((view) => view.state)).toEqual([{ status: 'killed', cause: 'engine-exit' }]);
  });

  it('numbers jobs per session and refuses ids it never gave', async () => {
    const { registry, start } = jobs();
    await start('a', 'true', tmpdir());
    await start('a', 'true', tmpdir());
    await start('b', 'true', tmpdir());
    await registry.settled();
    expect(registry.views('a').map((view) => view.id)).toEqual(['bg-1', 'bg-2']);
    expect(registry.views('b').map((view) => view.id)).toEqual(['bg-1']);
    expect(() => registry.output('a', 'bg-7', undefined)).toThrow('no background command bg-7 in this session');
    expect(() => registry.output('a', '../etc', undefined)).toThrow('no background command ../etc in this session');
  });
});

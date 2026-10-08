import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startPool, type Launch, type Pool } from './broker.js';
import { post, type Done, type Job, type Lease, type Order } from './protocol.js';

/**
 * A stand-in for VS Code with the pool host in it: each extension host says hello, follows its order, runs a job by
 * calling `suite` and reports the result. `restartMidRun` has the host restart while a named suite runs.
 */
type FakeOptions = { readonly fail?: Record<string, string>; readonly restartMidRun?: string; readonly hangOn?: string };

function fakeVscode(options: FakeOptions = {}) {
  const launches: string[] = [];
  const hosts: { window: number; folder: string }[] = [];
  const ran: { window: number; suite: string; env: Readonly<Record<string, string>>; host: number }[] = [];
  const killed: number[] = [];
  const launch: Launch = (window, folder, url) => {
    launches.push(folder);
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    let alive = true;
    const host = async (folder: string): Promise<void> => {
      hosts.push({ window: window.id, folder });
      const hostNumber = hosts.length;
      let order = await post<Order>(`${url}/host`, { window: window.id, folder, fresh: true });
      for (;;) {
        if (!alive) return;
        if (order.do === 'open') return host(order.folder);
        if (order.do === 'reload') return host(folder);
        if (order.do === 'quit') return void ((alive = false), exit());
        if (order.do === 'ignore') return;
        const name = path.basename(order.job.suite);
        ran.push({ window: window.id, suite: name, env: order.job.env, host: hostNumber });
        if (options.hangOn === name) return;
        if (options.restartMidRun === name) return host(folder);
        const message = options.fail?.[name];
        await post(`${url}/done`, { window: window.id, ...(message === undefined ? {} : { error: { message } }) } satisfies Done);
        order = await post<Order>(`${url}/host`, { window: window.id, folder, fresh: false });
      }
    };
    // A host still waiting when the pool closes loses its connection, as a real one does when its window quits.
    void host(folder).catch(() => undefined);
    return {
      exited,
      kill: () => {
        killed.push(window.id);
        alive = false;
        exit();
      },
    };
  };
  return { launch, launches, hosts, ran, killed };
}

let pool: Pool | undefined;
let port = 40000;
afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

const start = async (capacity: number, fake: ReturnType<typeof fakeVscode>, startMs?: number) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-test-'));
  pool = await startPool({ capacity, dir, launch: fake.launch, freePort: async () => ++port, ...(startMs === undefined ? {} : { startMs }) });
  return pool.url;
};

/** A job in a new folder of its own, with `user` files in its User folder. */
function job(suite: string, user: Record<string, string> = {}, workspace?: string): Job {
  const work = mkdtempSync(path.join(tmpdir(), 'pool-job-'));
  const folder = workspace ?? path.join(work, 'workspace');
  mkdirSync(folder, { recursive: true });
  mkdirSync(path.join(work, 'ud', 'User'), { recursive: true });
  for (const [name, text] of Object.entries(user)) writeFileSync(path.join(work, 'ud', 'User', name), text);
  return { suite: `/bundles/${suite}`, workspace: folder, user: path.join(work, 'ud', 'User'), env: { GCODE_HOME: path.join(work, 'home') }, log: path.join(work, 'log') };
}

const run = (url: string, lease: Lease, j: Job) => post<{ error?: { message: string } }>(`${url}/run`, { id: lease.id, job: j });

describe('the VS Code window pool', () => {
  it('runs suite after suite in one launched window, each in a fresh extension host in its own folder', async () => {
    const fake = fakeVscode();
    const url = await start(2, fake);
    const lease = await post<Lease>(`${url}/lease`, {});
    const [a, b, c] = [job('a.js'), job('b.js'), job('c.js')];
    expect(await run(url, lease, a)).toEqual({});
    expect(await run(url, lease, b)).toEqual({});
    expect(await run(url, lease, c)).toEqual({});
    expect(fake.launches, 'one launch, in the first suite’s folder').toEqual([a.workspace]);
    expect(fake.ran.map((r) => r.suite)).toEqual(['a.js', 'b.js', 'c.js']);
    expect(new Set(fake.ran.map((r) => r.host)).size, 'no host ran two suites').toBe(3);
    expect(fake.ran.map((r) => r.env['GCODE_HOME'])).toEqual([a.env['GCODE_HOME'], b.env['GCODE_HOME'], c.env['GCODE_HOME']]);
  });

  it('reloads the window to run a second suite in the same folder, as the reload suites need', async () => {
    const fake = fakeVscode();
    const url = await start(1, fake);
    const lease = await post<Lease>(`${url}/lease`, {});
    const first = job('attention.js');
    await run(url, lease, first);
    await run(url, lease, { ...first, suite: '/bundles/attention-reload.js' });
    expect(fake.hosts.map((h) => h.folder)).toEqual([first.workspace, first.workspace]);
    expect(fake.ran.map((r) => r.suite)).toEqual(['attention.js', 'attention-reload.js']);
  });

  it('gives each suite its own User files: settings.json reset to empty and other files removed when it brings none', async () => {
    const fake = fakeVscode();
    const url = await start(1, fake);
    const lease = await post<Lease>(`${url}/lease`, {});
    const user = path.join(lease.userData, 'User');
    await run(url, lease, job('mcp.js', { 'settings.json': '{"gcode.baseUrl":"x"}', 'mcp.json': '{"servers":{}}' }));
    expect(readFileSync(path.join(user, 'settings.json'), 'utf8')).toBe('{"gcode.baseUrl":"x"}');
    expect(existsSync(path.join(user, 'mcp.json'))).toBe(true);
    // A suite wrote a global setting, as a theme switch does.
    writeFileSync(path.join(user, 'settings.json'), '{"workbench.colorTheme":"Default Light Modern"}');
    await run(url, lease, job('chat.js'));
    expect(readFileSync(path.join(user, 'settings.json'), 'utf8')).toBe('{}');
    expect(existsSync(path.join(user, 'mcp.json'))).toBe(false);
  });

  it('reports a suite’s error, and the window runs the next suite after it', async () => {
    const fake = fakeVscode({ fail: { 'bad.js': 'the card never showed' } });
    const url = await start(1, fake);
    const lease = await post<Lease>(`${url}/lease`, {});
    expect(await run(url, lease, job('bad.js'))).toEqual({ error: { message: 'the card never showed' } });
    expect(await run(url, lease, job('good.js'))).toEqual({});
    expect(fake.launches).toHaveLength(1);
  });

  it('fails a suite whose extension host restarted while it ran', async () => {
    const fake = fakeVscode({ restartMidRun: 'flaky.js' });
    const url = await start(1, fake);
    const lease = await post<Lease>(`${url}/lease`, {});
    expect(await run(url, lease, job('flaky.js'))).toEqual({ error: { message: 'the extension host restarted while the suite ran' } });
  });

  it('never has more windows than its capacity: a second file waits, then gets the first one’s window', async () => {
    const fake = fakeVscode();
    const url = await start(1, fake);
    const first = await post<Lease>(`${url}/lease`, {});
    await run(url, first, job('a.js'));
    let second: Lease | undefined;
    const waiting = post<Lease>(`${url}/lease`, {}).then((l) => (second = l));
    await new Promise((r) => setTimeout(r, 50));
    expect(second, 'no window is free yet').toBeUndefined();
    await post(`${url}/release`, { id: first.id });
    await waiting;
    expect(second!.id).toBe(first.id);
    await run(url, second!, job('b.js'));
    expect(fake.launches).toHaveLength(1);
  });

  it('closes an idle window to make room for a file that launches VS Code itself', async () => {
    const fake = fakeVscode();
    const url = await start(1, fake);
    const lease = await post<Lease>(`${url}/lease`, {});
    await run(url, lease, job('a.js'));
    await post(`${url}/release`, { id: lease.id });
    await post(`${url}/reserve`, {});
    expect(fake.killed).toEqual([lease.id]);
    let next: Lease | undefined;
    const waiting = post<Lease>(`${url}/lease`, {}).then((l) => (next = l));
    await new Promise((r) => setTimeout(r, 50));
    expect(next, 'the reservation holds the only place').toBeUndefined();
    await post(`${url}/unreserve`, {});
    await waiting;
    expect(next!.id).not.toBe(lease.id);
  });

  it('closes a window released while its suite still runs, as when the test timed out', async () => {
    const fake = fakeVscode({ hangOn: 'stuck.js' });
    const url = await start(1, fake);
    const lease = await post<Lease>(`${url}/lease`, {});
    const stuck = run(url, lease, job('stuck.js'));
    await new Promise((r) => setTimeout(r, 50));
    await post(`${url}/release`, { id: lease.id });
    expect(await stuck).toEqual({ error: { message: 'the window was closed before the suite finished' } });
    expect(fake.killed).toEqual([lease.id]);
  });

  it('fails a suite whose window never starts it, and closes that window', async () => {
    const fake = fakeVscode();
    const silent: Launch = (w) => {
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => (exit = resolve));
      return { exited, kill: () => (fake.killed.push(w.id), exit()) };
    };
    const url = await start(1, { ...fake, launch: silent }, 100);
    const lease = await post<Lease>(`${url}/lease`, {});
    expect(await run(url, lease, job('never.js'))).toEqual({ error: { message: 'the window did not start never.js within 0.1 s' } });
    expect(fake.killed).toEqual([lease.id]);
  });
});

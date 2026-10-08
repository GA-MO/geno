import { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Done, Hello, Job, Lease, Order } from './protocol.js';

/** A running VS Code: `exited` settles when its main process ends. */
export type Proc = { readonly exited: Promise<void>; kill(force: boolean): void };
/** Starts VS Code on `folder` for `window`, with GCODE_POOL_URL and GCODE_POOL_WINDOW in its env. */
export type Launch = (window: { readonly id: number; readonly debugPort: number; readonly userData: string}, folder: string, poolUrl: string) => Proc;

export type PoolOptions = {
  /** Most VS Code windows open at once, counting the launches files make themselves. */
  readonly capacity: number;
  readonly dir: string;
  readonly launch: Launch;
  readonly freePort: () => Promise<number>;
  /** How long a window may take to open a job's folder and start its suite. */
  readonly startMs?: number;
};
export type Pool = { readonly url: string; close(): Promise<void> };

type Failure = NonNullable<Done['error']>;
type Pending = { readonly job: Job; readonly workspace: string; readonly settle: (error: Failure | undefined) => void };
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening'; readonly pending: Pending; readonly timer: NodeJS.Timeout }
  | { readonly kind: 'running'; readonly pending: Pending };

type PooledWindow = {
  readonly id: number;
  readonly debugPort: number;
  readonly userData: string;
  /**
   * An empty folder a released window opens, so the last suite's extension host, and its connections to the test's
   * servers, end with the test rather than when the next suite starts.
   */
  readonly park: string;
  leased: boolean;
  phase: Phase;
  proc: Proc | undefined;
  /** The folder its extension host last said it had open. */
  folder: string | undefined;
  /** The held reply of a host waiting for its next order. */
  waiting: ((order: Order) => void) | undefined;
  /** The User files the last job brought, which the next job's replace or remove. */
  userFiles: Set<string>;
};

type Waiter = { readonly kind: 'lease' | 'reserve'; readonly grant: (lease?: Lease) => void; gone: boolean };

const real = (folder: string): string => {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
};

/**
 * Lends test files long-lived VS Code windows. A file leases a window, and each suite it runs opens the suite's own
 * folder in it, which starts a fresh extension host with the suite's env, so suites share no extension state. The
 * window's User files are reset to the suite's before the folder opens.
 */
export async function startPool(options: PoolOptions): Promise<Pool> {
  const startMs = options.startMs ?? 120_000;
  const windows = new Map<number, PooledWindow>();
  const dying = new Set<Proc>();
  const queue: Waiter[] = [];
  let reservations = 0;
  let seq = 0;
  let url = '';

  const used = () => windows.size + dying.size + reservations;

  const finish = (w: PooledWindow, error: Failure | undefined) => {
    if (w.phase.kind === 'idle') return;
    if (w.phase.kind === 'opening') clearTimeout(w.phase.timer);
    const { pending } = w.phase;
    w.phase = { kind: 'idle' };
    pending.settle(error);
  };

  /** Ends the window's VS Code and forgets it; it counts against the capacity until it has exited. */
  const retire = (w: PooledWindow) => {
    windows.delete(w.id);
    finish(w, { message: 'the window was closed before the suite finished' });
    const proc = w.proc;
    w.proc = undefined;
    if (proc === undefined) return;
    dying.add(proc);
    proc.kill(false);
    const force = setTimeout(() => proc.kill(true), 10_000);
    void proc.exited.then(() => {
      clearTimeout(force);
      dying.delete(proc);
      pump();
    });
  };

  const syncUser = (w: PooledWindow, from: string) => {
    const dir = path.join(w.userData, 'User');
    mkdirSync(dir, { recursive: true });
    const brought = new Set(readdirSync(from, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name));
    for (const name of new Set([...w.userFiles, ...brought, 'settings.json'])) {
      if (brought.has(name)) copyFileSync(path.join(from, name), path.join(dir, name));
      else if (name === 'settings.json') writeFileSync(path.join(dir, name), '{}');
      else rmSync(path.join(dir, name), { force: true });
    }
    w.userFiles = brought;
  };

  const orderFor = (w: PooledWindow, pending: Pending): Order =>
    w.folder === pending.workspace ? { do: 'reload' } : { do: 'open', folder: pending.job.workspace };

  const launch = (w: PooledWindow, folder: string) => {
    const proc = options.launch(w, folder, url);
    w.proc = proc;
    w.folder = undefined;
    void proc.exited.then(() => {
      if (w.proc !== proc) return;
      w.proc = undefined;
      w.folder = undefined;
      w.waiting = undefined;
      finish(w, { message: 'VS Code exited before the suite finished' });
    });
  };

  const run = (w: PooledWindow, job: Job): Promise<Failure | undefined> => {
    if (w.phase.kind !== 'idle') throw new Error(`window ${w.id} is already running ${path.basename(w.phase.pending.job.suite)}`);
    syncUser(w, job.user);
    const workspace = real(job.workspace);
    return new Promise((settle) => {
      const pending: Pending = { job, workspace, settle };
      const timer = setTimeout(() => {
        finish(w, { message: `the window did not start ${path.basename(job.suite)} within ${startMs / 1000} s` });
        retire(w);
      }, startMs);
      w.phase = { kind: 'opening', pending, timer };
      if (w.proc === undefined) launch(w, job.workspace);
      else if (w.waiting !== undefined) {
        const reply = w.waiting;
        w.waiting = undefined;
        reply(orderFor(w, pending));
      }
    });
  };

  const hello = (h: Hello, reply: (order: Order) => void, res: ServerResponse) => {
    const w = windows.get(h.window);
    if (w === undefined || h.folder === null) return reply({ do: 'ignore' });
    w.folder = real(h.folder);
    if (h.fresh && w.phase.kind === 'running') finish(w, { message: 'the extension host restarted while the suite ran' });
    if (w.phase.kind === 'opening') {
      const { pending, timer } = w.phase;
      if (!h.fresh || w.folder !== pending.workspace) return reply(orderFor(w, pending));
      clearTimeout(timer);
      w.phase = { kind: 'running', pending };
      return reply({ do: 'run', job: pending.job });
    }
    if (!w.leased && w.folder !== real(w.park)) return reply({ do: 'open', folder: w.park });
    w.waiting?.({ do: 'ignore' });
    w.waiting = reply;
    res.on('close', () => {
      if (w.waiting === reply) w.waiting = undefined;
    });
  };

  const newWindow = async (): Promise<PooledWindow> => {
    const id = ++seq;
    const userData = path.join(options.dir, String(id), 'ud');
    mkdirSync(path.join(userData, 'User'), { recursive: true });
    const park = path.join(options.dir, String(id), 'park');
    mkdirSync(park);
    const w: PooledWindow = { id, debugPort: await options.freePort(), userData, park, leased: true, phase: { kind: 'idle' }, proc: undefined, folder: undefined, waiting: undefined, userFiles: new Set() };
    windows.set(id, w);
    return w;
  };

  const leaseOf = (w: PooledWindow): Lease => ({ id: w.id, debugPort: w.debugPort, userData: w.userData });

  /** Grants waiting leases and reservations in order while the capacity allows. */
  function pump(): void {
    while (queue.length > 0) {
      const head = queue[0]!;
      if (head.gone) {
        queue.shift();
        continue;
      }
      const free = [...windows.values()].find((w) => !w.leased);
      if (head.kind === 'lease') {
        if (free !== undefined) {
          free.leased = true;
          queue.shift();
          head.grant(leaseOf(free));
          continue;
        }
        if (used() >= options.capacity) return;
        queue.shift();
        // Counted against the capacity from now, before the port is found.
        reservations++;
        void newWindow().then((w) => {
          reservations--;
          head.grant(leaseOf(w));
        });
        continue;
      }
      if (used() >= options.capacity) {
        if (free === undefined) return;
        retire(free);
        continue;
      }
      queue.shift();
      reservations++;
      head.grant();
    }
  }

  const wait = (kind: Waiter['kind'], res: ServerResponse, send: (body: unknown) => void) => {
    const waiter: Waiter = { kind, grant: (lease) => send(lease ?? {}), gone: false };
    res.on('close', () => {
      if (!res.writableFinished) waiter.gone = true;
    });
    queue.push(waiter);
    pump();
  };

  const leased = (id: number): PooledWindow => {
    const w = windows.get(id);
    if (w === undefined || !w.leased) throw new Error(`no leased window ${id}`);
    return w;
  };

  const routes: Record<string, (body: any, send: (body: unknown) => void, res: ServerResponse) => void> = {
    '/lease': (_body, send, res) => wait('lease', res, send),
    '/reserve': (_body, send, res) => wait('reserve', res, send),
    '/unreserve': (_body, send) => {
      reservations--;
      send({});
      pump();
    },
    '/run': ({ id, job }: { id: number; job: Job }, send) => void run(leased(id), job).then((error) => send(error === undefined ? {} : { error })),
    '/release': ({ id }: { id: number }, send) => {
      const w = windows.get(id);
      if (w !== undefined) {
        w.leased = false;
        if (w.phase.kind !== 'idle') retire(w);
        else if (w.waiting !== undefined && w.folder !== real(w.park)) {
          const reply = w.waiting;
          w.waiting = undefined;
          reply({ do: 'open', folder: w.park });
        }
      }
      send({});
      pump();
    },
    '/host': (h: Hello, send, res) => hello(h, send, res),
    '/done': (d: Done, send) => {
      const w = windows.get(d.window);
      if (w?.phase.kind === 'running') finish(w, d.error);
      send({});
    },
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (text += chunk));
    req.on('end', () => {
      const route = req.method === 'POST' ? routes[req.url ?? ''] : undefined;
      if (route === undefined) return void res.writeHead(404).end();
      const send = (body: unknown) => {
        if (!res.writableEnded) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      try {
        route(text === '' ? {} : JSON.parse(text), send, res);
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
  });
  // A suite's run is one request that lasts as long as the suite.
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    async close() {
      const exits = [...windows.values()].flatMap((w) => (w.proc === undefined ? [] : [w.proc.exited]));
      for (const w of windows.values()) {
        if (w.waiting !== undefined && w.phase.kind === 'idle') {
          w.waiting({ do: 'quit' });
          w.waiting = undefined;
          const proc = w.proc;
          const force = setTimeout(() => proc?.kill(true), 10_000);
          void proc?.exited.then(() => clearTimeout(force));
        } else retire(w);
      }
      await Promise.all([...exits, ...[...dying].map((p) => p.exited)]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

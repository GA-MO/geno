import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, childrenOf, type TurnEvent } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { call, report, say, scripted, sessionIdOf, to } from './conformance/scripted.js';
import { answer, fakeTransport, loadTools, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const files = { 'a.ts': 'export const alpha = 1;\n', '.gcode.json': '{ "agentTool": ["non-interactive"] }\n' };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const isolated = (id: string, task: string) => ({ id, name: 'agent', input: { agent: 'worker', task, isolation: 'worktree' } });
const read = (id: string) => call('', [{ id, name: 'read', input: { path: 'a.ts' } }]);
const edit = (id: string, from: string, to: string) => call('', [{ id, name: 'edit', input: { path: 'a.ts', old_str: from, new_str: to } }]);
const childStarts = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.kind === 'child-start' ? [e] : []));
/** Each child's run from its logged start to its logged end, by the call that started it. */
const spans = (events: readonly TurnEvent[]) => {
  const ms = (at: string) => Date.parse(at);
  const ends = new Map(events.flatMap((e) => (e.kind === 'child-end' ? [[e.toolUseId, ms(e.at)] as const] : [])));
  return new Map(childStarts(events).map((start) => [start.toolUseId, { start: ms(start.at), end: ends.get(start.toolUseId)! }] as const));
};
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
type Run = Awaited<ReturnType<typeof scripted>>;
const asked = (run: Run, marker: string) => run.openings().some((opening) => opening.first.includes(marker));
/** Waits until `marker`'s conversation made a request, or `ms` passed, which the logged times then tell apart. */
const gate = async (run: Run, marker: string, ms: number) => {
  const deadline = Date.now() + ms;
  while (!asked(run, marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};
const laneOf = (workspace: string, child: string) => {
  const name = `worker-${child.slice(0, 8)}`;
  return { name, dir: path.join(workspace, '.geno', 'worktrees', name) };
};

describe('subagents in lanes', () => {
  it('C/C-14 two workers edit the same file at once in lanes of their own: each lane keeps its edit, and the main checkout is unchanged until the user applies one', async () => {
    const run: Run = await scripted(
      'anthropic',
      [
        to('[parent]', call('Two attempts.', [isolated('tu_w1', '[w2] Make alpha 2.'), isolated('tu_w2', '[w3] Make alpha 3.')])),
        to('[w2]', async () => (await gate(run, '[w3]', 5000), read('tu_r1'))),
        to('[w2]', edit('tu_e1', 'alpha = 1', 'alpha = 2')),
        to('[w2]', report('alpha is 2.', 'tu_rep1')),
        to('[w3]', read('tu_r2')),
        to('[w3]', edit('tu_e2', 'alpha = 1', 'alpha = 3')),
        to('[w3]', report('alpha is 3.', 'tu_rep2')),
        to('[parent]', say('Both lanes are ready.')),
      ],
      files,
    );
    const result = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', '--allow-worker', '[parent] Try alpha 2 and alpha 3.']);
    expect(result.code, result.stderr).toBe(0);

    const events = await run.log(result.stdout);
    const ran = spans(events);
    expect(overlap(ran.get('tu_w1')!, ran.get('tu_w2')!), `the two lane workers overlap: ${JSON.stringify([...ran])}`).toBe(true);
    const [first, second] = childStarts(events).map((start) => laneOf(run.workspace, start.child));
    expect(first!.name).not.toBe(second!.name);
    expect(readFileSync(path.join(first!.dir, 'a.ts'), 'utf8')).toBe('export const alpha = 2;\n');
    expect(readFileSync(path.join(second!.dir, 'a.ts'), 'utf8')).toBe('export const alpha = 3;\n');
    expect(readFileSync(path.join(run.workspace, 'a.ts'), 'utf8')).toBe('export const alpha = 1;\n');
    expect(git(run.workspace, 'status', '--porcelain'), 'the main checkout is untouched').toBe('');
    expect(git(run.workspace, 'log', '--oneline').trim().split('\n')).toHaveLength(1);

    const results = run.seen().at(-1)!.results;
    expect(results.map((r) => r.id)).toEqual(['tu_w1', 'tu_w2']);
    expect(results[0]!.text).toContain(`lane ${first!.name}, on branch geno/${first!.name}`);
    expect(results[1]!.text).toContain(`lane ${second!.name}, on branch geno/${second!.name}`);

    const listed = await run.cli(['lane', 'list', '--workspace', run.workspace]);
    expect(listed.stdout).toMatch(new RegExp(`${first!.name}\\s+changed`));
    expect(listed.stdout).toMatch(new RegExp(`${second!.name}\\s+changed`));
    expect((await run.cli(['lane', 'apply', first!.name, '--workspace', run.workspace])).code, 'the existing apply takes a kept lane').toBe(0);
    expect(readFileSync(path.join(run.workspace, 'a.ts'), 'utf8')).toBe('export const alpha = 2;\n');
    expect((await run.cli(['lane', 'apply', second!.name, '--workspace', run.workspace])).code, 'and the other lane now conflicts').toBe(1);
  });

  it('C/C-14 two workers in the main checkout still run one after the other', async () => {
    const worker = (id: string, task: string) => ({ id, name: 'agent', input: { agent: 'worker', task } });
    const run: Run = await scripted(
      'anthropic',
      [
        to('[parent]', call('Two looks.', [worker('tu_w1', '[w2] Look at alpha.'), worker('tu_w2', '[w3] Look at alpha again.')])),
        to('[w2]', async () => (await gate(run, '[w3]', 1000), report('alpha is 1.', 'tu_rep1'))),
        to('[w3]', report('alpha is still 1.', 'tu_rep2')),
        to('[parent]', say('Both looked.')),
      ],
      files,
    );
    const result = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', '--allow-worker', '[parent] Look at alpha twice.']);
    expect(result.code, result.stderr).toBe(0);

    const ran = spans(await run.log(result.stdout));
    expect(ran.size).toBe(2);
    expect(overlap(ran.get('tu_w1')!, ran.get('tu_w2')!), `the main checkout's writers do not overlap: ${JSON.stringify([...ran])}`).toBe(false);
    expect(run.seen().at(-1)!.results.map((r) => r.id)).toEqual(['tu_w1', 'tu_w2']);
  });

  it('message_agent resumes a lane child in its kept lane, where its earlier edit is, and the new report names the same lane', async () => {
    const loadMessage = call('', [{ id: 'tu_load', name: 'tool_search', input: { select: ['message_agent'] } }]);
    const run = await scripted('anthropic', [call('', [isolated('tu_w', 'Make alpha 2.')]), read('tu_r1'), edit('tu_e1', 'alpha = 1', 'alpha = 2'), report('alpha is 2.'), say('Done.')], files);
    const first = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', '--allow-worker', 'Make alpha 2.']);
    expect(first.code, first.stderr).toBe(0);
    const parentId = sessionIdOf(first.stdout);
    const childId = childStarts(await run.events(parentId))[0]!.child;
    const lane = laneOf(run.workspace, childId);
    run.more(
      loadMessage,
      call('', [{ id: 'tu_msg', name: 'message_agent', input: { agent_session: childId, text: 'Now make it 4.' } }]),
      read('tu_r2'),
      edit('tu_e2', 'alpha = 2', 'alpha = 4'),
      report('alpha is 4.', 'tu_report_2'),
      say('It is 4 now.'),
    );
    const second = await run.cli(['agent', '--session', parentId, '--non-interactive', '--allow-worker', 'Make it 4.']);
    expect(second.code, second.stderr).toBe(0);

    expect(readFileSync(path.join(lane.dir, 'a.ts'), 'utf8'), "the edit from 2 to 4 found the first run's edit").toBe('export const alpha = 4;\n');
    expect(readFileSync(path.join(run.workspace, 'a.ts'), 'utf8')).toBe('export const alpha = 1;\n');
    const answered = run.seen().at(-1)!.results[0]!.text;
    expect(answered).toContain('  alpha is 4.');
    expect(answered).toContain(`lane ${lane.name}, on branch geno/${lane.name}`);
  });

  it('a resumed child whose clean lane was removed gets a lane of the same name again', async () => {
    const loadMessage = call('', [{ id: 'tu_load', name: 'tool_search', input: { select: ['message_agent'] } }]);
    const run = await scripted('anthropic', [call('', [isolated('tu_w', 'Look at alpha.')]), report('alpha is 1; nothing to do.'), say('Nothing to do.')], files);
    const first = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', '--allow-worker', 'Look at alpha.']);
    expect(first.code, first.stderr).toBe(0);
    const parentId = sessionIdOf(first.stdout);
    const childId = childStarts(await run.events(parentId))[0]!.child;
    const lane = laneOf(run.workspace, childId);
    expect(existsSync(lane.dir), 'the clean lane is gone').toBe(false);
    run.more(loadMessage, call('', [{ id: 'tu_msg', name: 'message_agent', input: { agent_session: childId, text: 'Make it 2 after all.' } }]), read('tu_r'), edit('tu_e', 'alpha = 1', 'alpha = 2'), report('alpha is 2.', 'tu_report_2'), say('Done.'));
    expect((await run.cli(['agent', '--session', parentId, '--non-interactive', '--allow-worker', 'Make it 2.'])).code).toBe(0);

    expect(readFileSync(path.join(lane.dir, 'a.ts'), 'utf8')).toBe('export const alpha = 2;\n');
    expect(readFileSync(path.join(run.workspace, 'a.ts'), 'utf8')).toBe('export const alpha = 1;\n');
  });
});

type Body = { readonly messages: { readonly role: string; readonly content: unknown }[] };
type Script = (n: number, body: Body) => Reply | Promise<Reply>;
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

function models(scripts: Readonly<Record<string, Script>>) {
  const requests = new Map<string, Body[]>(Object.keys(scripts).map((marker) => [marker, []]));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const marker = Object.keys(scripts).find((m) => JSON.stringify(body.messages[0]).includes(m))!;
    const seen = requests.get(marker)!;
    seen.push(body);
    return fakeTransport([await scripts[marker]!(seen.length - 1, body)]).fetch(input, init);
  };
  return { fetch, requests: (marker: string) => requests.get(marker)! };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('stopping a background subagent in a lane', () => {
  it('task_stop cancels it with its partial report, and its clean lane is removed', async () => {
    const scout = '---\nname: scout\ndescription: Looks for names in a lane.\ntools: Grep\nisolation: worktree\n---\nFind names.\n';
    let lane = '';
    let running = false;
    const model = models({
      '[parent]': async (n, body) => {
        if (n === 0) return toolCall('Starting a scout.', [{ id: 'tu_a', name: 'agent', input: { agent: 'scout', task: '[child] where is alpha', background: true } }, loadTools('task_stop')], usage);
        if (n === 1) {
          const childId = /subagent session ([0-9a-f-]{36})/.exec(JSON.stringify(body.messages.at(-1)!.content))![1]!;
          await until(() => model.requests('[child]').length === 2, "the scout's second model call");
          lane = path.join(workspace, '.geno', 'worktrees', `scout-${childId.slice(0, 8)}`);
          running = existsSync(lane);
          return toolCall('Enough.', [{ id: 'tu_stop', name: 'task_stop', input: { id: childId } }], usage);
        }
        return answer('Stopped it.', usage);
      },
      '[child]': (n) => (n === 0 ? toolCall('Found alpha in a.ts:1 so far.', [{ id: 'tu_grep', name: 'grep', input: { pattern: 'alpha' } }], usage) : { events: [], hang: true }),
    });
    const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { ...files, '.agents/agents/scout.md': scout } }]));
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = {
      GCODE_HOME: home,
      HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: 'qwen3.8-flash',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', '[parent] find alpha in the background'], env, { fetch: model.fetch });
    expect(result.code, result.stderr).toBe(0);

    expect(running, 'the scout ran in its lane').toBe(true);
    expect(JSON.stringify(model.requests('[child]')[0]!.messages[0])).toContain(`Workspace: ${lane}`);
    const stopped = JSON.stringify(model.requests('[parent]')[2]!.messages.at(-1)!.content);
    expect(stopped).toMatch(/status=\\"cancelled\\" partial=\\"true\\"/);
    expect(stopped).toContain('Found alpha in a.ts:1 so far.');
    expect(existsSync(lane), 'the stopped scout changed nothing, so its lane is gone').toBe(false);
    expect(git(workspace, 'branch', '--list', 'geno/*')).toBe('');
    const events = (await readSessionLog(sessionFile(openStore(env), asSessionId(sessionIdOf(result.stdout))))).events;
    expect(childrenOf(events).map((child) => child.status)).toEqual([{ kind: 'cancelled', by: 'model' }]);
  });
});

import { readFile } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { NOT_USER_LINE, openSchedulesOf } from '@g-code/core';
import { gcodeAgent } from '../../src/serve.js';
import { call, closeServers, say, scripted, WIRES, type Wire } from './scripted.js';

afterEach(closeServers);

const load = (...names: string[]) => ({ id: `tu_load_${names.join('_')}`, name: 'tool_search', input: { select: names } });
const stop = (id: string, use = `tu_stop_${id}`) => ({ id: use, name: 'task_stop', input: { id } });
const list = (use: string) => ({ id: use, name: 'list_agents', input: {} });

/** Every tool result the model read, by its call's id. */
const resultsOf = (run: Awaited<ReturnType<typeof scripted>>) => new Map(run.seen().flatMap((request) => request.results.map((result) => [result.id, result] as const)));

describe.each(WIRES)('background work on the %s wire', (wire: Wire) => {
  it('T-BG-01 a background command returns its id and output file at once, and its end notice names the file and keeps the tail', async () => {
    const command = 'echo started; sleep 0.3; echo finished';
    const run = await scripted(wire, [
      call('Starting it.', [{ id: 'tu_bg', name: 'bash', input: { command, run_in_background: true } }]),
      call('Waiting.', [{ id: 'tu_wait', name: 'bash', input: { command: 'sleep 1' } }]),
      say('Done.'),
    ]);
    expect((await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Run it.'])).code).toBe(0);

    const started = run.seen()[1]!.results[0]!;
    expect(started.error).toBe(false);
    const file = /^Started background command bg-1\. Its whole output goes to (\S+bg-1\.log)\./.exec(started.text)?.[1];
    expect(file, started.text).toBeDefined();
    expect(await readFile(file!, 'utf8')).toBe('started\nfinished\n');
    const notice = run.seen()[2]!.text;
    expect(notice.split('\n')[0]).toBe(NOT_USER_LINE);
    expect(notice).toContain(`Background command bg-1 (\`${command}\`) exited with code 0. Its whole output is in ${file}.`);
    expect(notice, "Geno keeps the tail, which saves a read").toMatch(/<command_output id="bg-1">\nstarted\nfinished\n<\/command_output>/);
  });

  it('T-BG-03 task_stop stops a background command and says so; a second stop and unknown ids are errors that say why', async () => {
    const run = await scripted(wire, [
      call('Starting it.', [{ id: 'tu_bg', name: 'bash', input: { command: 'sleep 30', run_in_background: true } }, load('task_stop', 'list_agents')]),
      call('Stopping it.', [stop('bg-1')]),
      call('Checking.', [stop('bg-1', 'tu_again'), stop('bg-9'), stop('wake-1'), stop('explore'), list('tu_list')]),
      say('Stopped.'),
    ]);
    expect((await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Run it, then stop it.'])).code).toBe(0);

    const results = resultsOf(run);
    expect(results.get('tu_stop_bg-1')).toMatchObject({ error: false, text: expect.stringMatching(/^Stopped background command bg-1 \(`sleep 30`\)\. Its whole output is in \S+bg-1\.log\./) });
    expect(results.get('tu_again')).toMatchObject({ error: true, text: expect.stringMatching(/bg-1 is not running: it was stopped/) });
    expect(results.get('tu_stop_bg-9')).toMatchObject({ error: true, text: expect.stringMatching(/no background command bg-9 in this session/) });
    expect(results.get('tu_stop_wake-1')).toMatchObject({ error: true, text: expect.stringMatching(/no monitor, wake-up or PR watch wake-1 is pending in this session/) });
    expect(results.get('tu_stop_explore')).toMatchObject({ error: true, text: expect.stringMatching(/takes a bg-N background command, a wake-N .* or a subagent's session id; list_agents lists them/) });
    expect(results.get('tu_list')).toMatchObject({ error: false, text: expect.stringMatching(/^- bg-1: background command `sleep 30`, cancelled, started \d+s ago\. Output: \S+bg-1\.log$/m) });
    expect(run.seen().map((request) => request.text).join('\n'), 'a stop the model made sends no end notice').not.toContain('Background command bg-1');
  });
});

describe.each(WIRES)('wake-ups on the %s wire', (wire: Wire) => {
  it('T-BG-06 a wake-up lives in the session, list_agents shows it, task_stop cancels it, and it never fires', async () => {
    const run = await scripted(wire, [
      call('Loading.', [load('schedule_wakeup', 'task_stop', 'list_agents')]),
      call('Scheduling.', [{ id: 'tu_wake', name: 'schedule_wakeup', input: { delay_s: 60, reason: 'check CI' } }]),
      call('Listing.', [list('tu_before')]),
      call('Cancelling.', [stop('wake-1')]),
      call('Listing.', [list('tu_after')]),
      say('Cancelled.'),
    ]);
    // A wake-up's minute lasts 1.2s here, so one that still fired would do so within the wait below.
    run.env['GCODE_WAKE_POLICY'] = JSON.stringify({ batchMs: 50, secondMs: 20 });
    let sessionId = '';
    const editor = acp
      .client({ name: 'conformance' })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }))
      .onNotification(acp.methods.client.session.update, () => {});
    await editor.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      ({ sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] }));
      const turn = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Check CI in a minute.' }] });
      expect(turn.stopReason).toBe('end_turn');
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });

    const results = resultsOf(run);
    const loaded = results.get('tu_load_schedule_wakeup_task_stop_list_agents')!.text;
    expect(loaded, 'the schedule_wakeup definition the model loads warns against polling').toMatch(/Do not schedule a short wake-up to poll for background work you started/);
    expect(results.get('tu_wake')!.text).toMatch(/^Scheduled wake-up wake-1 for /);
    expect(results.get('tu_before')!.text).toMatch(/^- wake-1: wake-up, pending, due in \d+s: check CI$/m);
    expect(results.get('tu_stop_wake-1')).toMatchObject({ error: false, text: 'Cancelled wake-up wake-1. It will not wake you.' });
    expect(results.get('tu_after')!.text).not.toContain('wake-1');
    const events = await run.events(sessionId);
    expect(openSchedulesOf(events), 'an engine started now would arm nothing').toEqual([]);
    expect(events.filter((e) => e.kind === 'user' && e.from === 'wake'), 'no woken turn').toEqual([]);
    expect(run.seen(), 'no model call after the turn').toHaveLength(6);
  });
});

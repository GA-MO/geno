import { acp, agentCall, allowOnce, answer, anyText, ASK_WHERE, atCeiling, call, CHECK_TASK, childIdIn, cliFlow, editorFlow, editVersion, EXPLORE_TASK, type Flow, FOUND, gate, grep, inFork, later, loadMessageAgent, LONG, notFork, read, report, say, sleep, SMALL_WINDOW, STEER_META, stopsWith, TASKS_CAPABILITY, sized, thinkingOnly, to, toolCall, until, usage, VERSION_DOC, WORKER_REPORT, WORKER_TASK, WORKFLOWS_CAPABILITY } from './kit.js';

export const BASE: readonly Flow[] = [
  {
    name: 'worker-blocking',
    what: 'The parent hands worker a change and waits for its report in the same call.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('Make parseVersion', agentCall('toolu_agent_1', { agent: 'worker', task: WORKER_TASK }, 'I will hand this change to a worker subagent.')),
          to(WORKER_TASK, read('toolu_read_1', 'src/version.ts')),
          to(WORKER_TASK, editVersion),
          to(WORKER_TASK, report(WORKER_REPORT, 'toolu_report_1')),
          to('Make parseVersion', say('parseVersion now throws on an empty string (src/version.ts:2). Nothing tests that yet.')),
        ],
        [['--non-interactive', '--allow-worker', 'Make parseVersion throw on an empty string.']],
      ),
  },
  {
    name: 'explore',
    what: 'The parent asks the read-only explore subagent where a function is called.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, grep('toolu_grep_1', 'parseVersion\\(')),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
        ],
        [['--non-interactive', ASK_WHERE]],
      ),
  },
  {
    name: 'report-nudge',
    what: 'explore ends a turn with text and no report call; Geno nudges it once, and it reports.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, grep('toolu_grep_1', 'parseVersion\\(')),
          to(EXPLORE_TASK, say(FOUND)),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
        ],
        [['--non-interactive', ASK_WHERE]],
      ),
  },
  {
    name: 'report-forced',
    what: "explore uses its turns on searches; Geno forces its last call to be report.",
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, grep('toolu_grep_1', 'parseVersion')),
          to(EXPLORE_TASK, read('toolu_read_1', 'src/cli.ts')),
          to(EXPLORE_TASK, read('toolu_read_2', 'src/update.ts')),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
        ],
        [['--non-interactive', ASK_WHERE]],
      ),
  },
  {
    name: 'project-agent',
    what: "The parent starts an agent the project defines in .claude/agents/release-notes.md.",
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('Draft a release note', agentCall('toolu_agent_1', { agent: 'release-notes', task: 'Write a one-line release note for the change to parseVersion.' })),
          to('Write a one-line release note', read('toolu_read_1', 'src/version.ts')),
          to('Write a one-line release note', report('- parseVersion now returns [0, 0, 0] for an empty string.', 'toolu_report_1')),
          to('Draft a release note', say('Release note: parseVersion now returns [0, 0, 0] for an empty string.')),
        ],
        [['--non-interactive', 'Draft a release note for parseVersion.']],
        {
          '.claude/agents/release-notes.md':
            '---\nname: release-notes\ndescription: Writes a short release note for a change.\ntools: Read, Grep\nmaxTurns: 3\n---\nYou write release notes. Read the changed code, then report one Markdown bullet in plain words a user understands. No file paths.\n',
        },
      ),
  },
  {
    name: 'fork',
    what: 'The parent forks plan, which starts from a copy of the conversation and reports with its last text.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          notFork('throw on an empty string', read('toolu_read_1', 'src/version.ts')),
          notFork(
            'throw on an empty string',
            agentCall('toolu_agent_1', { agent: 'plan', fork: true, task: 'Plan the change we just discussed: which callers must change, and in what order.' }),
          ),
          inFork(grep('toolu_grep_1', 'parseVersion\\(')),
          inFork(
            say(
              '1. src/version.ts:2: throw Error("empty version") instead of returning [0, 0, 0].\n2. src/cli.ts:3: it passes process.argv[2] ?? "", so print usage when no argument is given before calling parseVersion.\n3. src/update.ts:3 passes its arguments through; leave it.\nRisk: any caller outside src. Check: run the CLI with no argument.',
            ),
          ),
          notFork('throw on an empty string', say('The plan: change src/version.ts:2, then guard src/cli.ts:3 so the CLI prints usage instead of throwing.')),
        ],
        [['--non-interactive', 'Plan how to make parseVersion throw on an empty string without breaking its callers.']],
      ),
  },
  {
    name: 'at-mention',
    what: 'The user types @explore in the prompt; Geno makes the agent call itself, with no parent model call first.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [to(ASK_WHERE, grep('toolu_grep_1', 'parseVersion\\(')), to(ASK_WHERE, report(FOUND, 'toolu_report_1'))],
        [['--non-interactive', `@explore ${ASK_WHERE}`]],
      ),
  },
  {
    name: 'message-finished',
    what: 'In a later turn the parent sends message_agent to explore, which had finished; Geno resumes it from its own log.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, grep('toolu_grep_1', 'parseVersion\\(')),
          to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
          to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
          to(ASK_WHERE, loadMessageAgent),
          to(ASK_WHERE, (request) => call('', [{ id: 'toolu_msg_1', name: 'message_agent', input: { agent_session: childIdIn(request.body), text: 'Which of those calls can pass an empty string?' } }])),
          to(EXPLORE_TASK, report('src/cli.ts:3 can: it passes process.argv[2] ?? "". src/update.ts:3 passes its own arguments through.', 'toolu_report_2')),
          to(ASK_WHERE, say('Only src/cli.ts:3 can pass an empty string.')),
        ],
        [['--non-interactive', ASK_WHERE], ['--non-interactive', 'Which of them can pass an empty string?']],
      ),
  },
  (() => {
    const steered = gate();
    const reported = gate();
    return {
      name: 'background-steer',
      what: 'The parent starts explore in the background, steers it with message_agent while it runs, and its report arrives during the parent’s turn.',
      run: () =>
        cliFlow(
          ['non-interactive'],
          [
            to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true })),
            to(ASK_WHERE, loadMessageAgent),
            to(ASK_WHERE, (request) => (steered.open(), call('', [{ id: 'toolu_msg_1', name: 'message_agent', input: { agent_session: childIdIn(request.body), text: 'Skip test files.' } }]))),
            to(ASK_WHERE, async () => {
              await reported.opened;
              await sleep(300);
              return read('toolu_read_1', 'package.json');
            }),
            to(EXPLORE_TASK, async () => (await steered.opened, await sleep(300), grep('toolu_grep_1', 'parseVersion\\('))),
            to(EXPLORE_TASK, () => (reported.open(), report(FOUND, 'toolu_report_1'))),
            to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3, and the package has no test files to skip.')),
          ],
          [['--non-interactive', ASK_WHERE]],
        ),
    };
  })(),
  (() => {
    const waiting = gate();
    return {
      name: 'cli-holds',
      what: 'The parent starts explore in the background and ends its turn; the CLI holds the turn open until the report wakes it.',
      run: () =>
        cliFlow(
          ['non-interactive'],
          [
            to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true })),
            to(ASK_WHERE, () => (waiting.open(), say('explore is searching in the background; I will answer when its report comes.'))),
            to(EXPLORE_TASK, async () => (await waiting.opened, grep('toolu_grep_1', 'parseVersion\\('))),
            to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
            to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
          ],
          [['--non-interactive', ASK_WHERE]],
        ),
    };
  })(),
  {
    name: 'child-permission',
    what: 'In Ask mode worker asks to run a command off the safe list; the editor shows the card and the user picks Allow.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Add a check script', agentCall('toolu_agent_1', { agent: 'worker', task: CHECK_TASK }, 'I will hand this to a worker subagent.')),
          to(CHECK_TASK, read('toolu_read_1', 'package.json')),
          to(CHECK_TASK, call('', [{ id: 'toolu_bash_1', name: 'bash', input: { command: 'npm pkg set scripts.check="tsc --noEmit"' } }])),
          to(CHECK_TASK, read('toolu_read_2', 'package.json')),
          to(CHECK_TASK, report('Ran npm pkg set scripts.check="tsc --noEmit". package.json:7 now has "check": "tsc --noEmit"; I read the file back to confirm. I did not run it.', 'toolu_report_1')),
          to('Add a check script', say('worker added a check script (tsc --noEmit) to package.json:7. It has not run it yet.')),
        ],
        'Add a check script that runs tsc --noEmit to package.json.',
        { permission: (params) => params.options.find((option) => option.kind === 'allow_once')!.optionId },
      ),
  },
  {
    name: 'child-cancelled',
    what: 'The user cancels explore from its row while it streams; the parent gets the partial report.',
    run: () => {
      let cancelled = false;
      return editorFlow(
        ['ask'],
        'ask',
        [
          to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
          to(EXPLORE_TASK, sized((use) => ({ ...answer('I will search for calls of parseVersion, then read each file that has one to give its line', use), stallAfter: 8 }))),
          to(ASK_WHERE, say('You stopped explore before it reported anything, so I have no calls to show yet. Say if you want me to search again.')),
        ],
        ASK_WHERE,
        {
          update: (params, ctx) => {
            const update = params.update as { sessionUpdate: string; sessionId?: string; state?: { state: string } };
            if (update.sessionUpdate === 'subagent_update' && update.state?.state === 'running' && !cancelled) {
              cancelled = true;
              setTimeout(() => void ctx.notify(acp.methods.agent.session.cancel, { sessionId: update.sessionId! }), 300);
            }
          },
        },
      );
    },
  },
  (() => {
    const ended = gate();
    return {
      name: 'background-wake',
      what: 'The parent starts explore in the background and ends its turn; the report wakes the session for a new turn.',
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to('in the background', agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK, background: true }, 'Starting explore in the background.')),
            to(EXPLORE_TASK, async () => (await ended.opened, grep('toolu_grep_1', 'parseVersion\\('))),
            to('in the background', () => (ended.open(), say('explore is searching in the background; I will tell you what it finds.'))),
            to(EXPLORE_TASK, report(FOUND, 'toolu_report_1')),
            to('in the background', say('parseVersion is called in src/cli.ts:3 and twice in src/update.ts:3.')),
          ],
          'Find where parseVersion is called, in the background.',
          { settled: (requests) => until(() => requests() === 5, 'the woken turn') },
          { GCODE_WAKE_POLICY: JSON.stringify({ batchMs: 50, secondMs: 20 }) },
        ),
    };
  })(),
  {
    name: 'worktree-lane',
    what: 'The parent runs worker in a lane of its own and waits; the report names the kept lane.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('in a lane', agentCall('toolu_agent_1', { agent: 'worker', task: WORKER_TASK, isolation: 'worktree' })),
          to(WORKER_TASK, read('toolu_read_1', 'src/version.ts')),
          to(WORKER_TASK, editVersion),
          to(WORKER_TASK, report(WORKER_REPORT, 'toolu_report_1')),
          to('in a lane', say('worker changed src/version.ts:2 in its lane. Review it there, then apply it with gcode lane apply.')),
        ],
        [['--non-interactive', '--allow-worker', 'Make parseVersion throw on an empty string, in a lane.']],
      ),
  },
  {
    name: 'refused-writer',
    what: 'In a non-interactive run without --allow-worker, Geno refuses to start worker, and the parent does the change itself.',
    run: () =>
      cliFlow(
        ['non-interactive'],
        [
          to('Make parseVersion', agentCall('toolu_agent_1', { agent: 'worker', task: WORKER_TASK })),
          to('Make parseVersion', read('toolu_read_1', 'src/version.ts')),
          to('Make parseVersion', editVersion),
          to('Make parseVersion', say('worker could not start here, so I changed src/version.ts:2 myself: parseVersion now throws on an empty string.')),
        ],
        [['--non-interactive', 'Make parseVersion throw on an empty string.']],
      ),
  },
  (() => {
    let running = 0;
    const reviewing = gate();
    const REVIEW_TASK = 'Review the uncommitted changes in this workspace for bugs.';
    const hang = { anthropic: { events: [], hang: true as const } };
    return {
      name: 'parent-stop',
      what: 'The user presses Stop while explore runs blocking and review runs in the background; the next turn shows what the parent model reads of both.',
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to('Review my change', agentCall('toolu_agent_1', { agent: 'review', task: REVIEW_TASK, background: true })),
            to(REVIEW_TASK, () => (reviewing.open(), hang)),
            to('Review my change', async () => (await reviewing.opened, agentCall('toolu_agent_2', { agent: 'explore', task: EXPLORE_TASK }))),
            to(EXPLORE_TASK, hang),
            to('Review my change', say('I stopped where you pressed Stop: neither subagent reported. Say if you want me to run them again.')),
          ],
          ['Review my change and find where parseVersion is called.', 'Go on.'],
          {
            update: (params, ctx) => {
              const update = params.update as { sessionUpdate: string; state?: { state: string } };
              if (update.sessionUpdate === 'subagent_update' && update.state?.state === 'running' && ++running === 2) {
                setTimeout(() => void ctx.notify(acp.methods.agent.session.cancel, { sessionId: params.sessionId }), 300);
              }
            },
          },
        ),
    };
  })(),
  (() => {
    let steer = (): Promise<unknown> => Promise.reject(new Error('explore has not started'));
    return {
      name: 'user-steers-child',
      what: "While explore runs, the user types into explore's own conversation; the message reaches explore at its next model call.",
      run: () =>
        editorFlow(
          ['ask'],
          'ask',
          [
            to(ASK_WHERE, agentCall('toolu_agent_1', { agent: 'explore', task: EXPLORE_TASK })),
            to(EXPLORE_TASK, async () => (void steer(), await sleep(300), grep('toolu_grep_1', 'parseVersion\\('))),
            to(EXPLORE_TASK, report('src/cli.ts:3 calls parseVersion on the first CLI argument. I skipped src/update.ts, as you asked.', 'toolu_report_1')),
            to(ASK_WHERE, say('parseVersion is called in src/cli.ts:3; explore skipped src/update.ts as you asked.')),
          ],
          ASK_WHERE,
          {
            update: (params, ctx) => {
              const update = params.update as { sessionUpdate: string; sessionId?: string; state?: { state: string } };
              if (update.sessionUpdate !== 'subagent_update' || update.state?.state !== 'running') return;
              steer = () => ctx.request(acp.methods.agent.session.prompt, { sessionId: update.sessionId!, prompt: [{ type: 'text', text: 'Skip src/update.ts.' }], _meta: { [STEER_META]: true } });
            },
          },
        ),
    };
  })(),
  {
    name: 'workflow-run',
    what: 'The user runs /workflow fix-bug; each step runs as a subagent with its prompt filled in, and the run report wakes the chat.',
    run: () =>
      editorFlow(
        ['ask', 'auto'],
        'auto',
        [
          to('Find where', grep('toolu_grep_1', 'parseVersion')),
          to('Find where', report("src/version.ts:2 returns [0, 0, 0] for '' instead of failing.", 'toolu_report_1')),
          to('Fix it.', read('toolu_read_1', 'src/version.ts')),
          to('Fix it.', editVersion),
          to('Fix it.', report(WORKER_REPORT, 'toolu_report_2')),
          { when: (request) => anyText(request.body).includes('Started workflow fix-bug'), answer: say('The workflow fix-bug finished: parseVersion now throws on an empty string (src/version.ts:2).') },
        ],
        '/workflow fix-bug parseVersion accepts an empty string',
        {
          files: {
            '.g-code/workflows/fix-bug.json': `${JSON.stringify(
              {
                description: 'Find where a bug comes from, then fix it.',
                input: 'What is broken',
                steps: [
                  { id: 'reproduce', role: 'explore', prompt: 'Find where this goes wrong: {{input}}. Cite path:line.' },
                  { id: 'fix', role: 'worker', prompt: 'Fix it. What the reproduce step found:\n{{reproduce}}' },
                ],
              },
              null,
              2,
            )}\n`,
          },
          meta: { [TASKS_CAPABILITY]: true, [WORKFLOWS_CAPABILITY]: true },
          settled: (requests) => until(() => requests() === 6, 'the woken turn'),
        },
        { GCODE_WAKE_POLICY: JSON.stringify({ batchMs: 50, secondMs: 20 }) },
      ),
  },
  {
    name: 'max-tokens',
    what: 'A tool call cut at the full max_tokens is not run, and the model is told to call again smaller. Later the context is long, the request carries a lower max_tokens, and a text answer cut at it ends the turn.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Write docs/version.md', call('I will read parseVersion first.', [{ id: 'toolu_read_0', name: 'read', input: { path: 'src/version.ts' } }])),
          to('Write docs/version.md', atCeiling(toolCall('', [{ id: 'toolu_edit_1', name: 'edit', input: { path: 'docs/version.md', create: true, new_str: VERSION_DOC(12) } }], usage(1000), { cutOff: true }))),
          to(
            'Write docs/version.md',
            call('That call was cut off. I will write the first part of the file now and add the rest after.', [{ id: 'toolu_edit_2', name: 'edit', input: { path: 'docs/version.md', create: true, new_str: VERSION_DOC(2) } }], { input: 65_100 }),
          ),
          to('Write docs/version.md', stopsWith('end_turn', 'docs/version.md now has its first two cases. Say if you want the rest.', 65_300)),
          later('Explain what package.json', call('', [{ id: 'toolu_read_1', name: 'read', input: { path: 'package.json' } }], { input: LONG })),
          later('Explain what package.json', atCeiling(answer('package.json sets up three things. The first is', usage(LONG), { stopReason: 'max_tokens' }))),
        ],
        ['Write docs/version.md that documents every case parseVersion handles.', 'Explain what package.json sets up.'],
        { permission: allowOnce },
        SMALL_WINDOW,
      ),
  },
  {
    name: 'pause-or-malformed-stop',
    what: 'One answer ends with pause_turn and Geno calls the model again at once; in the next turn an answer ends with tool_use but has no tool call, and the turn fails.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('Look at how this project', stopsWith('pause_turn', 'Looking at how the project is laid out.')),
          to('Look at how this project', call('', [{ id: 'toolu_list_1', name: 'list', input: {} }])),
          to('Look at how this project', say('The project has src/version.ts, which parses versions, and src/cli.ts and src/update.ts, which call it.')),
          later('Which file should I', stopsWith('tool_use', 'Start with src/version.ts.')),
        ],
        ['Look at how this project is laid out.', 'Which file should I read first?'],
      ),
  },
  {
    name: 'refusal',
    what: 'The model writes a short reason and ends with stop_reason refusal; Geno logs an error of kind refusal and the turn fails.',
    run: () =>
      editorFlow(['ask'], 'ask', [to('license check', stopsWith('refusal', 'I can’t help remove a license check.'))], 'Remove the license check from the vendored library so it runs without a key.'),
  },
  {
    name: 'empty-answer-nudged',
    what: 'The model ends its turn with only thinking: no text, no tool call. Geno adds a nudge to the next request once, and the model answers.',
    run: () =>
      editorFlow(
        ['ask'],
        'ask',
        [
          to('What does parseVersion return', thinkingOnly('The user asks what parseVersion returns for an empty string. I should find where it is defined and check how it treats an empty input.')),
          to('What does parseVersion return', call('I will read src/version.ts, where parseVersion most likely lives.', [{ id: 'toolu_read_1', name: 'read', input: { path: 'src/version.ts' } }])),
          to('What does parseVersion return', say('parseVersion returns [0, 0, 0] for an empty string (src/version.ts:2).')),
        ],
        'What does parseVersion return for an empty string?',
      ),
  },
];

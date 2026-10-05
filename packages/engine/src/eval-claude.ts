import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { addUsage, costOf, ZERO_USAGE, type TokenUsage } from '@g-code/core';
import { childEnv } from './child-env.js';
import { EngineError } from './errors.js';
import type { AgentAdapter, AgentRunResult } from './eval-run.js';
import { openSandbox, sandboxPolicy } from './sandbox.js';

/** Claude Code reaches qwen through Model Studio's Anthropic endpoint, so its turns bill at Model Studio's prices. */
const CLAUDE_CODE_PROVIDER = 'modelstudio';

export const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;

const count = z.number().int().nonnegative();
const apiUsage = z.looseObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count.nullish(),
  cache_creation_input_tokens: count.nullish(),
});

// Claude Code's stream-json lines. Only the fields this adapter reads are checked.
const assistantLine = z.looseObject({ type: z.literal('assistant'), message: z.looseObject({ id: z.string(), usage: apiUsage }) });
const modelUsage = z.looseObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count.nullish(),
  cacheCreationInputTokens: count.nullish(),
});
const resultLine = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  num_turns: count,
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: apiUsage.optional(),
  modelUsage: z.record(z.string(), modelUsage).optional(),
  permission_denials: z.array(z.unknown()).optional(),
});

const usageOf = (u: z.infer<typeof apiUsage>): TokenUsage => ({
  input: u.input_tokens,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  output: u.output_tokens,
});


// `usage` on the result covers the main loop only; modelUsage also counts subagent calls such as Explore.
export function resultUsage(result: z.infer<typeof resultLine>): TokenUsage | undefined {
  if (result.modelUsage !== undefined) {
    return Object.values(result.modelUsage)
      .map((u) => ({ input: u.inputTokens, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0, output: u.outputTokens }))
      .reduce(addUsage, ZERO_USAGE);
  }
  return result.usage === undefined ? undefined : usageOf(result.usage);
}

const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) throw new EngineError(`${name} is not set; the claude-code adapter points Claude Code at Model Studio with it`);
  return value;
}

/** The variables Claude Code reads for its endpoint, key and every model slot, all pointed at `model`. */
export function claudeEnv(
  env: Readonly<Record<string, string | undefined>>,
  model: string,
  dirs: { readonly home: string; readonly config: string; readonly tmp: string },
): Record<string, string> {
  return childEnv(env, {
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: dirs.config,
    // Claude Code's Bash tool keeps state under /tmp/claude-<uid> by default, which the sandbox cannot write.
    CLAUDE_CODE_TMPDIR: dirs.tmp,
    ANTHROPIC_BASE_URL: required(env, 'DASHSCOPE_BASE_URL'),
    ANTHROPIC_AUTH_TOKEN: required(env, 'DASHSCOPE_API_KEY'),
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  });
}

/**
 * Claude Code in print mode, inside the same sandbox as our bash except that the Model Studio host is
 * reachable. stream-json rather than json, so the per-task budget can stop it mid-run: Claude Code does not
 * know Model Studio's prices, so its own --max-budget-usd would count the wrong rates. The streamed
 * per-message usage carries input tokens only, so the mid-run estimate runs low; the recorded usage comes
 * from the final result line.
 */
export const claudeCodeAdapter: AgentAdapter = {
  async run(input, { io, store }) {
    const dirs = {
      home: path.join(input.tempDir, 'home'),
      config: path.join(input.tempDir, 'claude-config'),
      tmp: path.join(input.tempDir, 'claude-tmp'),
    };
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    const env = claudeEnv(io.env, input.model, dirs);
    const host = new URL(env['ANTHROPIC_BASE_URL']!).hostname;
    const realHome = io.env['HOME'] ?? '';
    const sandbox = await openSandbox(
      await sandboxPolicy({
        store,
        home: realHome,
        workspace: input.workspace,
        tempDir: input.tempDir,
        allowedDomains: [host],
        denyRead: [path.join(realHome, '.claude'), path.join(realHome, '.claude.json')],
      }),
    );
    const transcript = path.join(input.runDir, `${input.task.id}.claude.jsonl`);
    const lines: string[] = [];

    const seen = new Map<string, TokenUsage>();
    let result: z.infer<typeof resultLine> | undefined;
    let overBudget = false;
    const stop = new AbortController();
    let buffered = '';
    const onLine = (line: string) => {
      if (line.trim() === '') return;
      lines.push(line);
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const assistant = assistantLine.safeParse(raw);
      if (assistant.success) {
        const { message } = assistant.data;
        seen.set(message.id, usageOf(message.usage));
        const spent = costOf(CLAUDE_CODE_PROVIDER, input.model, [...seen.values()].reduce(addUsage, ZERO_USAGE)) ?? 0;
        if (spent > input.maxCostUsd && !overBudget) {
          overBudget = true;
          stop.abort();
        }
      }
      const final = resultLine.safeParse(raw);
      if (final.success) result = final.data;
    };
    const claude = io.env['GCODE_CLAUDE'] || 'claude';
    const command = [
      claude,
      '-p',
      shellQuote(input.task.prompt),
      '--output-format stream-json --verbose',
      `--model ${shellQuote(input.model)}`,
      '--permission-mode bypassPermissions',
      '--no-session-persistence',
    ].join(' ');
    let run;
    try {
      run = await sandbox.run(command, {
        cwd: input.workspace,
        env,
        timeoutMs: CLAUDE_TIMEOUT_MS,
        signal: stop.signal,
        onStdout: (chunk) => {
          buffered += chunk;
          const complete = buffered.split('\n');
          buffered = complete.pop()!;
          complete.forEach(onLine);
        },
      });
    } finally {
      await sandbox.close();
    }
    onLine(buffered);
    await writeFile(transcript, lines.map((line) => `${line}\n`).join(''));
    if (run.code !== 0 && result === undefined) {
      await writeFile(path.join(input.runDir, `${input.task.id}.claude.stderr.txt`), run.output);
    }

    const usage = (result === undefined ? undefined : resultUsage(result)) ?? [...seen.values()].reduce(addUsage, ZERO_USAGE);
    const stopReason: AgentRunResult['stop'] = overBudget
      ? 'budget'
      : run.timedOut
        ? 'timeout'
        : (result?.subtype ?? `exit ${run.code ?? 'killed'}`);
    return {
      stop: stopReason,
      turns: result?.num_turns ?? seen.size,
      usage,
      costUsd: costOf(CLAUDE_CODE_PROVIDER, input.model, usage),
      reportedCostUsd: result?.total_cost_usd ?? null,
      denials: result?.permission_denials?.length ?? 0,
      finalMessage: result?.result ?? '',
      transcript,
    };
  },
};

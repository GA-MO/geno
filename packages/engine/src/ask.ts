import { parseArgs } from 'node:util';
import { TOOL_DEFINITIONS } from '@g-code/core';
import type { Command } from './command.js';
import { DEFAULT_TURN_USD } from './agent.js';
import { drive, limitsOn, openForPrompt, positiveNumber } from './drive.js';
import { EXECUTORS } from './tools/index.js';
import { ruleAttacher, withRuleAttachments } from './tools/rules.js';

export const ask: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      session: { type: 'string' },
      workspace: { type: 'string' },
      'max-turns': { type: 'string', default: '25' },
      'max-cost': { type: 'string' },
    },
  });
  const question = positionals.join(' ').trim();
  const maxTurns = positiveNumber('max-turns', values['max-turns'], true);
  const maxCostUsd = values['max-cost'] === undefined ? DEFAULT_TURN_USD : positiveNumber('max-cost', values['max-cost'], false);

  const opened = await openForPrompt(io, store, values, question, 'question');
  const { exitCode } = await drive(io, store, opened, question, limitsOn({ maxTurns, maxCostUsd }, opened.log.session), {
    tools: TOOL_DEFINITIONS,
    executors: { ...EXECUTORS, read: withRuleAttachments(EXECUTORS.read, ruleAttacher(opened.log.events)) },
  });
  return exitCode;
};

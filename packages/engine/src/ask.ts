import { parseArgs } from 'node:util';
import { TOOL_DEFINITIONS } from '@g-code/core';
import type { Command } from './command.js';
import { drive, openForPrompt, positiveNumber } from './drive.js';
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
      'max-cost': { type: 'string', default: '0.40' },
    },
  });
  const question = positionals.join(' ').trim();
  const maxTurns = positiveNumber('max-turns', values['max-turns'], true);
  const maxCostUsd = positiveNumber('max-cost', values['max-cost'], false);

  const opened = await openForPrompt(io, store, values, question, 'question');
  const { exitCode } = await drive(io, store, opened, question, { maxTurns, maxCostUsd }, {
    tools: TOOL_DEFINITIONS,
    executors: { ...EXECUTORS, read: withRuleAttachments(EXECUTORS.read, ruleAttacher(opened.log.events)) },
  });
  return exitCode;
};

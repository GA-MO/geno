#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { ENGINE_ENV_FILE } from './child-env.js';
import { run } from './run.js';
import { terminalConfirm } from './terminal-confirm.js';

function projectEnv(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(ENGINE_ENV_FILE, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

process.exitCode = await run(process.argv.slice(2), {
  env: { ...projectEnv(), ...process.env },
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  write: (text) => process.stdout.write(text),
  confirm: terminalConfirm(process.stdin, process.stderr),
  interrupts: () => {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    return controller.signal;
  },
});

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { run } from './run.js';

// The engine runs inside other projects, so its .env is found next to the engine, not in cwd.
function projectEnv(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8'));
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
  interrupts: () => {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    return controller.signal;
  },
});

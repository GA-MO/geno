import { run } from '../src/run.js';

export async function runCli(argv: string[], env: Record<string, string>, cwd = process.cwd()) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(argv, {
    env,
    cwd,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

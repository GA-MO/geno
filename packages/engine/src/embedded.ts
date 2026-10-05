// The engine the VS Code extension bundles. Unlike cli.ts it reads no .env: the extension passes the provider,
// endpoint, model and key in the environment, and a .env found next to an installed extension is not the user's.
import { run } from './run.js';

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  write: (text) => process.stdout.write(text),
  // The extension asks the user through ACP permission requests, never on a terminal.
  confirm: async () => false,
  interrupts: () => {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    return controller.signal;
  },
});

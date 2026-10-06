// Runs one external agent inside Geno's sandbox, in a process of its own. sandbox-runtime keeps one network allowlist
// per process, and the engine's own sandbox allows no network, so an agent that needs its hosts cannot share it.
// The spec comes as base64 JSON in argv; stdio passes straight through, so the agent's ACP stream is untouched.
import { spawn } from 'node:child_process';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { z } from 'zod';

const spec = z.object({
  command: z.string().min(1),
  hosts: z.array(z.string()),
  writable: z.array(z.string()),
  denyRead: z.array(z.string()),
  readable: z.array(z.string()),
});

const parsed = spec.parse(JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')));
await SandboxManager.initialize({
  network: { allowedDomains: parsed.hosts, deniedDomains: [] },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
});
const wrapped = await SandboxManager.wrapWithSandbox(parsed.command, undefined, {
  filesystem: { denyRead: parsed.denyRead, allowRead: parsed.readable, allowWrite: parsed.writable, denyWrite: [] },
});
const child = spawn('/bin/sh', ['-c', wrapped], { stdio: 'inherit', detached: true });
const stop = () => {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', async (code, signal) => {
  await SandboxManager.reset().catch(() => {});
  process.exit(code ?? (signal === null ? 1 : 128));
});

import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifierRequest, denialFor, PACKAGE_HOSTS, type ClassifierInput } from '@g-code/core';
import { childEnv } from '../src/child-env.js';
import { openSandbox, sandboxDomainsOf, sandboxPolicy, type Sandbox } from '../src/sandbox.js';
import { openStore } from '../src/store.js';

describe('the sandbox network allowlist', () => {
  it('reaches the package hosts by default, adds the user\'s own hosts, and closes the package hosts only when they are off', () => {
    expect(sandboxDomainsOf({})).toEqual(PACKAGE_HOSTS);
    expect(sandboxDomainsOf({ GCODE_SANDBOX_ALLOWED_DOMAINS: '' })).toEqual(PACKAGE_HOSTS);
    expect(sandboxDomainsOf({ GCODE_SANDBOX_ALLOWED_DOMAINS: 'crates.io, *.example.com registry.npmjs.org https://x.test/a *' })).toEqual([...PACKAGE_HOSTS, 'crates.io', '*.example.com']);
    expect(sandboxDomainsOf({ GCODE_SANDBOX_PACKAGE_HOSTS: 'off' })).toEqual([]);
    expect(sandboxDomainsOf({ GCODE_SANDBOX_PACKAGE_HOSTS: 'off', GCODE_SANDBOX_ALLOWED_DOMAINS: 'registry.npmjs.org' })).toEqual(['registry.npmjs.org']);
    expect(sandboxDomainsOf({ GCODE_SANDBOX_PACKAGE_HOSTS: 'on' })).toEqual(PACKAGE_HOSTS);
  });

  it('tells the Auto classifier which hosts commands reach', () => {
    const input: ClassifierInput = { request: 'add dayjs', agentText: '', command: 'npm install dayjs', flagged: { rule: 'unlisted', reason: 'r', command: 'npm install dayjs' } };
    const system = JSON.stringify(classifierRequest(input, 'm', sandboxDomainsOf({})).system);
    expect(system).toContain(`it reaches the network only at these hosts, where *. covers subdomains: ${PACKAGE_HOSTS.join(', ')}.`);
  });

  it('still asks before an install in Ask, runs it in the sandbox in Auto, and refuses it in Plan', () => {
    const scope = { workspace: '/w', tempDir: '/t', home: '/h' };
    for (const command of ['npm install dayjs', 'pnpm add dayjs', 'pip install --target ./py six', 'git clone --depth 1 https://github.com/jonschlinkert/is-odd.git']) {
      expect(denialFor(command, scope, 'ask'), command).toMatchObject({ verdict: 'ask' });
      expect(denialFor(command, scope, 'auto'), command).toBeUndefined();
      expect(denialFor(command, scope, 'plan'), command).toMatchObject({ verdict: 'deny' });
    }
  });
});

/** Whether this machine reaches the npm registry at all; without it, the installs below have nothing to show. */
async function online(): Promise<boolean> {
  try {
    await lookup('registry.npmjs.org');
    return (await fetch('https://registry.npmjs.org/left-pad', { method: 'HEAD', signal: AbortSignal.timeout(8_000) })).ok;
  } catch {
    return false;
  }
}

const OFFLINE = !(await online());

describe.skipIf(OFFLINE)('the default sandbox on the real network (skipped offline: registry.npmjs.org did not answer)', () => {
  let workspace: string;
  let tempDir: string;
  let sandbox: Sandbox;

  beforeAll(async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-sandbox-net-')));
    workspace = path.join(root, 'ws');
    tempDir = path.join(root, 'tmp');
    const home = path.join(root, 'home');
    await mkdir(workspace);
    await mkdir(tempDir);
    await writeFile(path.join(workspace, 'package.json'), '{ "name": "probe", "version": "1.0.0", "private": true }\n');
    sandbox = await openSandbox(await sandboxPolicy({ store: openStore({ GCODE_HOME: home }), home, workspace, tempDir, allowedDomains: sandboxDomainsOf({}) }));
  });

  afterAll(async () => {
    await sandbox.close();
  });

  const run = (command: string) => sandbox.run(command, { cwd: workspace, env: childEnv(process.env), timeoutMs: 120_000 });

  it('installs a package from npm, with its cache in the temp dir', async () => {
    const result = await run('npm install left-pad@1.3.0 --no-audit --no-fund');
    expect(result.code, result.output).toBe(0);
    expect(existsSync(path.join(workspace, 'node_modules', 'left-pad', 'package.json'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8')).dependencies).toEqual({ 'left-pad': '^1.3.0' });
    expect(existsSync(path.join(tempDir, 'npm-cache'))).toBe(true);
  });

  it('refuses a host off the list, through the proxy and with a direct connection', async () => {
    const result = await run('curl -sS -m 10 -o /dev/null -w "%{http_code}" https://example.com/');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('CONNECT tunnel failed, response 403');
    const direct = await run(`node -e "fetch('https://example.com/').then(() => console.log('reached'), () => console.log('refused'))"`);
    expect(direct.output.trim()).toBe('refused');
  });
});

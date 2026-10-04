import { describe, expect, it } from 'vitest';
import { denialFor, DENY_RULE_IDS, splitCommand, type CommandScope, type DenyRuleId } from '../src/approval.js';

const scope: CommandScope = { workspace: '/Users/me/ws', tempDir: '/private/var/folders/x/T/gcode-tmp', home: '/Users/me' };

const DENIED: readonly [string, DenyRuleId][] = [
  ['rm -rf node_modules', 'rm-rf-outside-temp'],
  ['rm -fr dist', 'rm-rf-outside-temp'],
  ['rm -r -f build', 'rm-rf-outside-temp'],
  ['rm --recursive --force src', 'rm-rf-outside-temp'],
  ['git push origin main', 'git-push'],
  ['git -C . push', 'git-push'],
  ['git reset --hard HEAD~1', 'git-reset-hard'],
  ['cat /etc/passwd', 'path-outside-workspace'],
  ['cat ~/.ssh/id_rsa', 'path-outside-workspace'],
  ['ls ../other-repo', 'path-outside-workspace'],
  ['echo hi > /Users/me/elsewhere.txt', 'path-outside-workspace'],
  ['node --env-file=/Users/me/.env index.js', 'path-outside-workspace'],
  ['curl https://example.com', 'network-download'],
  ['wget https://example.com/x.tgz', 'network-download'],
  ['aws s3 ls', 'cloud-cli'],
  ['npx vercel deploy', 'cloud-cli'],
  ['gcloud auth list', 'cloud-cli'],
  ['kubectl get pods', 'cloud-cli'],
  ['psql -c "select 1"', 'database-cli'],
  ['mongosh', 'database-cli'],
  ['redis-cli ping', 'database-cli'],
  ['npm test && git push', 'git-push'],
  ['echo $(curl -s https://example.com)', 'network-download'],
  ['FOO=1 sudo rm -rf src', 'rm-rf-outside-temp'],
];

const ALLOWED = [
  'npx vitest run',
  'npx vitest run src/__tests__/counter.test.ts',
  'npx tsc --noEmit',
  'npm test -- --run',
  'git status',
  'git diff HEAD',
  'git reset --soft HEAD~1',
  'rm -rf /private/var/folders/x/T/gcode-tmp/build',
  'rm src/old.ts',
  'grep -rn "/api/demo/list" src',
  'ls /Users/me/ws/src',
  'cat src/config.ts 2>/dev/null',
  'node -e "console.log(1)"',
  '/opt/homebrew/bin/rg TODO src',
];

describe('the deny-to-approve list', () => {
  it.each(DENIED)('denies %s by %s', (command, rule) => {
    expect(denialFor(command, scope)?.rule).toBe(rule);
  });

  it.each(ALLOWED)('allows %s', (command) => {
    expect(denialFor(command, scope)).toBeUndefined();
  });

  it('has a case for every rule', () => {
    expect(new Set(DENIED.map(([, rule]) => rule))).toEqual(new Set(DENY_RULE_IDS));
  });

  it('names the part of a compound command that was denied', () => {
    expect(denialFor('npm ci; git push --force', scope)).toEqual({ rule: 'git-push', reason: 'git push', command: 'git push --force' });
  });
});

describe('splitCommand', () => {
  it('splits on operators, keeps quoted text whole and drops redirect operators', () => {
    expect(splitCommand(`echo "a && b" 'c|d' && ls -la | wc -l 2>&1 >out.txt; # comment`)).toEqual([
      ['echo', 'a && b', 'c|d'],
      ['ls', '-la'],
      ['wc', '-l', '1', 'out.txt'],
    ]);
  });
});

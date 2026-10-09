import { describe, expect, it } from 'vitest';
import { fileToolsOf, stepsOf } from '../src/shell-intent.js';

describe('stepsOf', () => {
  it('splits at operators outside quotes and groups, and keeps redirections apart', () => {
    const steps = stepsOf(`grep -n "a|b && c" src/x.ts 2>/dev/null | head -5; (cd sub && make) & echo 'x;y'`)!;
    expect(steps.map((s) => [s.text, s.then, s.redirects, s.grouped])).toEqual([
      ['grep -n "a|b && c" src/x.ts', '|', ['2>/dev/null'], false],
      ['head -5', ';', [], false],
      ['(cd sub && make)', '&', [], true],
      ["echo 'x;y'", 'end', [], false],
    ]);
    expect(steps[0]!.commands[0]!.args).toEqual(['-n', 'a|b && c', 'src/x.ts']);
  });

  it('reads &> and >& as redirections, not as a background operator', () => {
    expect(stepsOf('make &> log.txt; npm test 2>&1')!.map((s) => [s.then, s.redirects])).toEqual([
      [';', ['&>log.txt']],
      ['end', ['2>&1']],
    ]);
  });

  it('leaves a heredoc or an open quote to the shell', () => {
    expect(stepsOf("cat <<EOF > a.txt\nhi\nEOF")).toBeUndefined();
    expect(stepsOf("echo 'open")).toBeUndefined();
  });
});

describe('fileToolsOf', () => {
  const table: readonly (readonly [string, readonly string[]])[] = [
    ['cat package.json', ['read']],
    ['cat -n src/a.ts src/b.ts', ['read']],
    ['head -50 notes/deploy.txt', ['read']],
    ['head -n 20 src/a.ts', ['read']],
    ['tail -n +40 src/a.ts | head -20', ['read']],
    ["sed -n '1,40p' src/config.ts", ['read']],
    ['ls', ['list']],
    ['ls -la notes/', ['list']],
    ['ls -R . | head -50', ['list']],
    ['find . -name "*.ts" -not -path "*/node_modules/*"', ['glob']],
    ['find packages -type f | sort', ['glob']],
    ['find . -path ./node_modules -prune -o -type f -print | head -50', ['glob']],
    ['grep -rn "listen" src', ['grep']],
    ['grep -n "port" server.js | head -20', ['grep']],
    ['grep -rni --include=*.ts retries .', ['grep']],
    ['rg -n retries src', ['grep']],
    ['cat package.json; echo ---; ls -la', ['read', 'list']],
    ['cd /work/repo && cat a.ts 2>/dev/null', ['read']],
    ['ls -la notes/ && head -50 notes/* 2>/dev/null', ['list', 'read']],

    ['cat /proc/cpuinfo', []],
    ['cat', []],
    ['cat - < input.txt', []],
    ['tail -f server.log', []],
    ['head -c 100 a.bin', []],
    ['cat a.ts | wc -l', []],
    ['cat src/config.ts | od -c', []],
    ['ls | grep test', []],
    ['grep -l retries -r src', []],
    ['grep -c TODO src/a.ts', []],
    ['git log | grep fix', []],
    ['find . -name "*.tmp" -delete', []],
    ['find src -newer a.ts', []],
    ['cat a.ts > b.ts', []],
    ['cat > notes.txt <<EOF\nx\nEOF', []],
    ['cat $(git ls-files)', []],
    ['git status && cat a.ts', []],
    ['node --version && cat package.json', []],
    ['ls & sleep 1', []],
    ['echo done', []],
    ['sudo cat /etc/hosts', []],
    ['awk "{print $1}" a.txt', []],
  ];
  it.each(table)('%s', (command, tools) => {
    expect(fileToolsOf(command)).toEqual(tools);
  });
});

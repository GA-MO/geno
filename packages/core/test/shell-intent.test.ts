import { describe, expect, it } from 'vitest';
import { fileStepRefusal, fileStepsOf, serverRefusal, serverStartOf, stepsOf, writeStepsOf } from '../src/shell-intent.js';

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

  it('keeps a heredoc as a redirection and leaves its body out', () => {
    expect(stepsOf("cat <<'EOF' > a.txt && npm test\nx; rm -rf /\nEOF\necho done")!.map((s) => [s.text, s.then, s.redirects])).toEqual([
      ['cat', '&&', ["<<'EOF'", '>a.txt']],
      ['npm test', ';', []],
      ['echo done', 'end', []],
    ]);
    expect(stepsOf('cat <<-EOF\n\tx\n\tEOF')!.map((s) => s.redirects)).toEqual([['<<-EOF']]);
  });

  it('leaves a heredoc with no end line or an open quote to the shell', () => {
    expect(stepsOf('cat <<EOF > a.txt\nhi')).toBeUndefined();
    expect(stepsOf("echo 'open")).toBeUndefined();
  });
});

describe('fileStepsOf', () => {
  const read = (text: string) => ({ text, tool: 'read' });
  const table: readonly (readonly [string, readonly { text: string; tool: string }[]])[] = [
    ['cat package.json', [read('cat package.json')]],
    ['cat -n src/a.ts src/b.ts', [read('cat -n src/a.ts src/b.ts')]],
    ['head -50 notes/deploy.txt', [read('head -50 notes/deploy.txt')]],
    ['head -n 20 src/a.ts', [read('head -n 20 src/a.ts')]],
    ['tail -n +40 src/a.ts | head -20', [read('tail -n +40 src/a.ts | head -20')]],
    ["sed -n '1,40p' src/config.ts", [read("sed -n '1,40p' src/config.ts")]],
    ['ls', [{ text: 'ls', tool: 'list' }]],
    ['ls -R . | head -50', [{ text: 'ls -R . | head -50', tool: 'list' }]],
    ['find . -name "*.ts" -not -path "*/node_modules/*"', [{ text: 'find . -name "*.ts" -not -path "*/node_modules/*"', tool: 'glob' }]],
    ['find packages -type f | sort', [{ text: 'find packages -type f | sort', tool: 'glob' }]],
    ['grep -n "port" server.js | head -20', [{ text: 'grep -n "port" server.js | head -20', tool: 'grep' }]],
    ['grep -rni --include=*.ts retries .', [{ text: 'grep -rni --include=*.ts retries .', tool: 'grep' }]],
    ['rg -n retries src', [{ text: 'rg -n retries src', tool: 'grep' }]],
    ['cat a.ts 2>/dev/null', [read('cat a.ts 2>/dev/null')]],
    ['cat package.json; echo ---; ls -la', [read('cat package.json'), { text: 'ls -la', tool: 'list' }]],
    ['npm test 2>&1 | tail -15; grep -rn getUser . --exclude-dir=.git', [{ text: 'grep -rn getUser . --exclude-dir=.git', tool: 'grep' }]],
    ['ls src test; cat src/money.ts', [{ text: 'ls src test', tool: 'list' }, read('cat src/money.ts')]],
    ['npm run build && ls dist; cat a.ts', [read('cat a.ts')]],
    ['npm test || cat a.ts', [read('cat a.ts')]],
    ['cd src/shop && wc -l *.ts && cat cart.ts', [read('cat cart.ts')]],
    ['git status && cat a.ts', [read('cat a.ts')]],
    ['cd /work/repo && cat a.ts', [read('cat a.ts')]],
    ['(cd sub && make); cat a.ts', [read('cat a.ts')]],

    ['npm test 2>&1 | grep -E "not ok"', []],
    ['npm run build && ls dist', []],
    ['rm -rf build && ls -d build', []],
    ['mkdir -p out && npm run gen && ls out && cat out/a.ts', []],
    ['cat x | node y', []],
    ['git show HEAD:f | head', []],
    ['cat a.ts | wc -l', []],
    ['cat src/config.ts | od -c', []],
    ['ls | grep test', []],
    ['git log | grep fix', []],
    ['cat /proc/cpuinfo', []],
    ['cat', []],
    ['cat - < input.txt', []],
    ['tail -f server.log', []],
    ['head -c 100 a.bin', []],
    ['grep -l retries -r src', []],
    ['grep -c TODO src/a.ts', []],
    ['find . -name "*.tmp" -delete', []],
    ['find src -newer a.ts', []],
    ['cat a.ts > b.ts', []],
    ['cat a.ts | head > b.ts', []],
    ['cat > notes.txt <<EOF\nx\nEOF', []],
    ['cat $(git ls-files)', []],
    ['ls & sleep 1', []],
    ['echo done', []],
    ['cd sub && pwd', []],
    ['sudo cat /etc/hosts', []],
    ['awk "{print $1}" a.txt', []],
  ];
  it.each(table)('%s', (command, steps) => {
    expect(fileStepsOf(command)).toEqual(steps);
  });
});

describe('fileStepRefusal', () => {
  it('names each file step and its tool, and the rest of the line to run alone', () => {
    expect(fileStepRefusal('npm run build && npm test 2>&1 | tail -15; grep -rn getUser . --exclude-dir=.git; cat src/a.ts', '/work')).toBe(
      "Geno ran nothing: `grep -rn getUser . --exclude-dir=.git` is the grep tool's job and `cat src/a.ts` is the read tool's job. Run `npm run build && npm test 2>&1 | tail -15` alone in bash, and call grep and read in the same turn; they run at the same time.",
    );
  });

  it('keeps a cd with the program it runs before', () => {
    expect(fileStepRefusal('cd sub && npm test; cat a.ts', '/work')).toBe(
      "Geno ran nothing: `cat a.ts` is the read tool's job. Run `cd sub && npm test` alone in bash, and call read in the same turn; they run at the same time.",
    );
  });

  it('says only to call the tools when the line holds nothing else but labels', () => {
    expect(fileStepRefusal('ls src test; echo ---; cat src/money.ts', '/work')).toBe(
      "Geno ran nothing: `ls src test` is the list tool's job and `cat src/money.ts` is the read tool's job. Call list and read instead; calls in one turn run at the same time.",
    );
  });

  it('names a write step as the edit tool job, after && too', () => {
    expect(fileStepRefusal("mkdir -p test && cat > test/levels.test.js <<'EOF'\nimport x from 'y';\nEOF", '/work')).toBe(
      "Geno ran nothing: `cat >test/levels.test.js <<'EOF'` is the edit tool's job (create: true with the whole content). Run `mkdir -p test` alone in bash, and call edit.",
    );
    expect(fileStepRefusal('echo dist >> .gitignore; cat a.ts', '/work')).toBe(
      "Geno ran nothing: `echo dist >>.gitignore` is the edit tool's job (read the file, then add the text) and `cat a.ts` is the read tool's job. Call edit and read instead.",
    );
  });

  it('lets through a line with no file step and no write step', () => {
    expect(fileStepRefusal('npm test 2>&1 | grep -E "not ok"', '/work')).toBeUndefined();
    expect(fileStepRefusal("cat > \"$TMPDIR/gen.mjs\" <<'EOF'\nconsole.log(1)\nEOF\nnode \"$TMPDIR/gen.mjs\"", '/work')).toBeUndefined();
  });
});

describe('writeStepsOf', () => {
  const write = (text: string, files: string[], append = false) => [{ text, files, append }];
  const table: readonly (readonly [string, readonly { text: string; files: readonly string[]; append: boolean }[]])[] = [
    ["cat > test/levels.test.js <<'EOF'\nconst a = 1;\nEOF", write("cat >test/levels.test.js <<'EOF'", ['test/levels.test.js'])],
    ['cat <<EOF > notes.txt\nx\nEOF', write('cat <<EOF >notes.txt', ['notes.txt'])],
    ['echo x >> .gitignore', write('echo x >>.gitignore', ['.gitignore'], true)],
    ["printf '%s\\n' a b > list.txt", write("printf '%s\\n' a b >list.txt", ['list.txt'])],
    ["echo '$HOME is literal here' > a.txt", write("echo '$HOME is literal here' >a.txt", ['a.txt'])],
    ['echo "{}" > "config/app.json"', write('echo "{}" >"config/app.json"', ['config/app.json'])],
    ['echo hi | tee out.txt', write('echo hi | tee out.txt', ['out.txt'])],
    ['echo hi | tee -a log.txt >/dev/null', write('echo hi | tee -a log.txt >/dev/null', ['log.txt'], true)],
    ['npm run build && echo ok > status.txt', write('echo ok >status.txt', ['status.txt'])],
    ['cd src && echo x > a.ts', write('echo x >a.ts', ['a.ts'])],
    ['echo x > /work/a.txt', write('echo x >/work/a.txt', ['/work/a.txt'])],
    ['cat <<<"hi" > a.txt', write('cat <<<"hi" >a.txt', ['a.txt'])],

    ["printf '%s\\n' a > \"$TMPDIR/x\"", []],
    ["cat > $TMPDIR/gen.mjs <<'EOF'\nx\nEOF", []],
    ['echo x > /tmp/a.txt', []],
    ['echo x > ../other/a.txt', []],
    ['cd /tmp && echo x > a.txt', []],
    ['cd "$TMPDIR" && echo x > a.txt', []],
    ['echo x > ~/notes.txt', []],
    ['npm test > out.log', []],
    ['npm test > out.log 2>&1', []],
    ['node gen.mjs > a.js', []],
    ['cat a > b', []],
    ['cat < a > b', []],
    ['echo hi', []],
    ['echo hi >&2', []],
    ['echo hi > /dev/null 2>&1', []],
    ['echo "built $(date)" > stamp.txt', []],
    ['sleep 60 & echo $! > pid.txt', []],
    ['echo "v=$VERSION" > version.txt', []],
    ['grep -c "@returns" src/shop/*.ts | head -3', []],
    [`node -e "const m=require('./maze');console.log(m.MAZE.filter(r=>r.length!==28).length)"`, []],
  ];
  it.each(table)('%s', (command, steps) => {
    expect(writeStepsOf(command, '/work')).toEqual(steps);
  });
});

describe('serverStartOf', () => {
  const scripts = { dev: 'vite', start: 'node server.js', build: 'vite build', test: 'node --test', cli: 'node bin/cli.js' };
  const table: readonly (readonly [string, { server: string; background: boolean; rest: string } | undefined])[] = [
    ['node server.js & SRV=$!; sleep 4; curl -s localhost:5173/health; kill $SRV', { server: 'node server.js', background: true, rest: 'SRV=$!; sleep 4; curl -s localhost:5173/health; kill $SRV' }],
    ['node server.js > /tmp/s.log 2>&1 &', { server: 'node server.js', background: true, rest: '' }],
    ['nohup ./run-worker.sh > w.log &', { server: 'nohup ./run-worker.sh', background: true, rest: '' }],
    ['(cd app && npm run dev) &', { server: '(cd app && npm run dev)', background: true, rest: '' }],
    ['npm run dev', { server: 'npm run dev', background: false, rest: '' }],
    ['pnpm dev --port 4000', { server: 'pnpm dev --port 4000', background: false, rest: '' }],
    ['npm start', { server: 'npm start', background: false, rest: '' }],
    ['npx vite --port 5173 & sleep 2', { server: 'npx vite --port 5173', background: true, rest: 'sleep 2' }],
    ['python3 -m http.server 8000', { server: 'python3 -m http.server 8000', background: false, rest: '' }],
    ['next dev', { server: 'next dev', background: false, rest: '' }],

    ['npm run build && npm test', undefined],
    ['vite build', undefined],
    ['npm run cli -- --help', undefined],
    ['node bin/cli.js', undefined],
    ['node --test', undefined],
    ['make -j4 a & make b & wait', undefined],
    ['curl -sf http://localhost:5173/health', undefined],
    ['echo "npm run dev &"', undefined],
  ];
  it.each(table)('%s', (command, expected) => {
    expect(serverStartOf(command, scripts)).toEqual(expected);
  });

  it('counts a start script with an unknown body as a server only in the background', () => {
    expect(serverStartOf('npm start', {})).toBeUndefined();
    expect(serverStartOf('npm start &', {})?.background).toBe(true);
  });
});

describe('serverRefusal', () => {
  const start = serverStartOf('node server.js & sleep 3; curl -s http://localhost:5173/health', {})!;

  it('names the call that starts the server in the background, and an until-loop where nothing wakes the session', () => {
    const text = serverRefusal(start, { monitor: false });
    expect(text).toMatch(/^Blocked: `node server.js` starts a server, and with & it would keep running/);
    expect(text).toContain('{"command": "node server.js", "run_in_background": true}');
    expect(text).toContain('until curl -sf http://localhost:5173/health >/dev/null; do sleep 0.5; done');
    expect(text).toContain('`sleep 3; curl -s http://localhost:5173/health`');
    expect(text).toContain('task_stop');
    expect(text).not.toMatch(/monitor|preview_start/);
  });

  it('points to monitor where a line can wake the session, and to preview_start where a launch file has the server', () => {
    const text = serverRefusal({ server: 'npm run dev', background: false, rest: '' }, { monitor: true, launchFile: '.claude/launch.json' });
    expect(text).toMatch(/in the foreground it would hold this call until the timeout kills it/);
    expect(text).toMatch(/wait for it with monitor/);
    expect(text).toMatch(/preview_start .* reads \.claude\/launch\.json/);
    expect(text).not.toMatch(/until curl/);
  });
});

import { describe, expect, it } from 'vitest';
import { denialFor, DENY_RULE_IDS, splitCommand, type CommandScope, type DenyRuleId } from '../src/approval.js';

const scope: CommandScope = { workspace: '/Users/me/ws', tempDir: '/private/var/folders/x/T/gcode-tmp', home: '/Users/me' };

const DENIED: readonly [string, DenyRuleId][] = [
  ['rm -rf .', 'rm-rf-outside-workspace'],
  ['rm -rf ./', 'rm-rf-outside-workspace'],
  ['rm -rf src/..', 'rm-rf-outside-workspace'],
  ['rm -rf /Users/me/ws', 'rm-rf-outside-workspace'],
  ['rm -rf .git', 'rm-rf-outside-workspace'],
  ['rm -fr .git/objects', 'rm-rf-outside-workspace'],
  ['rm -rf ..', 'rm-rf-outside-workspace'],
  ['rm -rf ../other', 'rm-rf-outside-workspace'],
  ['rm -rf ~', 'rm-rf-outside-workspace'],
  ['rm -rf ~/', 'rm-rf-outside-workspace'],
  ['rm -rf ~/Documents', 'rm-rf-outside-workspace'],
  ['rm -rf ~root', 'rm-rf-outside-workspace'],
  ['rm -rf /', 'rm-rf-outside-workspace'],
  ['rm -rf /*', 'rm-rf-outside-workspace'],
  ['rm -rf /etc', 'rm-rf-outside-workspace'],
  ['rm -rf /tmp', 'rm-rf-outside-workspace'],
  ['rm -rf *', 'rm-rf-outside-workspace'],
  ['rm -rf .*', 'rm-rf-outside-workspace'],
  ['rm -rf ./*', 'rm-rf-outside-workspace'],
  ['rm -rf .g*', 'rm-rf-outside-workspace'],
  ['rm -rf ../*', 'rm-rf-outside-workspace'],
  ['rm -rf $HOME', 'rm-rf-outside-workspace'],
  ['rm -rf "$UNSET_ELSEWHERE"', 'rm-rf-outside-workspace'],
  ['rm -rf $(pwd)', 'rm-rf-outside-workspace'],
  ['S=/tmp/x; rm -rf $S/', 'rm-rf-outside-workspace'],
  ['d=$(mktemp -d); rm -rf $d/*', 'rm-rf-outside-workspace'],
  ['cd / && rm -rf Users', 'rm-rf-outside-workspace'],
  ['FOO=1 sudo rm -rf /', 'rm-rf-outside-workspace'],
  ['git push origin main', 'git-push'],
  ['git -C . push', 'git-push'],
  ['if true; then git push; fi', 'git-push'],
  ['for b in a; do git push origin $b; done', 'git-push'],
  ['git reset --hard HEAD~1', 'git-reset-hard'],
  ['cat /etc/passwd', 'path-outside-workspace'],
  ['cat ~/.ssh/id_rsa', 'path-outside-workspace'],
  ['cat $HOME/.ssh/id_rsa', 'path-outside-workspace'],
  ['ls ../other-repo', 'path-outside-workspace'],
  ['cd ..', 'path-outside-workspace'],
  ['cd ../other && ls', 'path-outside-workspace'],
  ['echo hi > ../file', 'path-outside-workspace'],
  ['echo hi > /Users/me/elsewhere.txt', 'path-outside-workspace'],
  ['node --env-file=/Users/me/.env index.js', 'path-outside-workspace'],
  ['echo "$(cat ../secret)"', 'path-outside-workspace'],
  ["cat > ../out.ts <<'EOF'\nexport {};\nEOF", 'path-outside-workspace'],
  ["cat > a.ts <<'EOF'\nexport {};\nEOF\ncat ../secret", 'path-outside-workspace'],
  ['curl https://example.com', 'network-download'],
  ['wget https://example.com/x.tgz', 'network-download'],
  ['echo "$(curl -s https://example.com)"', 'network-download'],
  ['cat <<EOF\n$(curl -s https://example.com)\nEOF', 'network-download'],
  ['aws s3 ls', 'cloud-cli'],
  ['npx vercel deploy', 'cloud-cli'],
  ['gcloud auth list', 'cloud-cli'],
  ['kubectl get pods', 'cloud-cli'],
  ['psql -c "select 1"', 'database-cli'],
  ['mongosh', 'database-cli'],
  ['redis-cli ping', 'database-cli'],
  ['npm test && git push', 'git-push'],
  ['echo $(curl -s https://example.com)', 'network-download'],
];

const ALLOWED = [
  'npx vitest run',
  'npx vitest run src/__tests__/counter.test.ts',
  'npx tsc --noEmit',
  'npm test -- --run',
  'git status',
  'git diff HEAD',
  'git reset --soft HEAD~1',
  'rm -rf node_modules',
  'rm -fr dist',
  'rm -r -f build',
  'rm --recursive --force src',
  'rm -rf ./build a/b/../c',
  'rm -rf .github',
  'rm -rf src/*',
  'rm -rf /Users/me/ws/dist',
  'rm -rf /private/var/folders/x/T/gcode-tmp/build',
  'rm -rf /tmp/scratch',
  'd=$(mktemp -d); rm -rf "$d"',
  'rm src/old.ts',
  'grep -rn "/api/demo/list" src',
  'ls /Users/me/ws/src',
  'cat src/config.ts 2>/dev/null',
  'node -e "console.log(1)"',
  `node -e "import('../src/x.js')"`,
  'git commit -m "move the helpers to ../shared"',
  "cat > a.ts <<'EOF'\nimport { x } from '../src/x';\nEOF",
  'cat > a.ts <<-EOF\n\timport { x } from "../src/x";\n\tEOF',
  'cat <<EOF\nsee ../README.md\nEOF',
  '/opt/homebrew/bin/rg TODO src',
];

// Every command the Phase 4 evals (E5 and E14 on qwen3.8-flash) denied, verbatim from the session logs.
const EVAL_FALSE_POSITIVES: readonly [string, string][] = [
  ['payload-migration-check-lines', String.raw`npm run check:migrations 2>&1 | tail -3
S=/tmp/migdemo; rm -rf $S; mkdir -p $S/src/migrations $S/scripts
printf "\nexport async function up({ db }: any) {\n  await db.execute('CREATE INDEX x ON y')\n  await db.execute('DROP TABLE a; DROP TABLE b')\n  await db.execute('TRUNCATE c')\n}\n" > $S/src/migrations/20260105_demo.ts
cp scripts/check-migrations.ts $S/scripts/
cd $S && ln -sf "$(cd - >/dev/null; pwd)" 2>/dev/null; true`],
  ['payload-site-url-runtime', String.raw`node --import tsx scripts/check-migrations.ts 2>&1 | head -5; echo ===; d=$(mktemp -d); mkdir -p $d/scripts $d/src/migrations; cp scripts/check-migrations.ts $d/scripts/; (cd $d && node --import tsx scripts/check-migrations.ts) 2>&1 | head -5; rm -rf $d`],
  ['payload-manual-code-fences', String.raw`git stash -q && mkdir -p .tmp-check && git show HEAD:src/lib/manual.ts | sed 's/^function parseSections/export function parseSections/' > .tmp-check/manual-old.ts && cat > .tmp-check/old.test.ts <<'EOF'
import { expect, it } from 'vitest'
import { parseSections } from './manual-old'
it('old parser leaks shell comments from ~~~ fences as headings', () => {
  const md = ['## Deploy', '', '~~~bash', '# update packages', '~~~', ''].join('\n')
  const got = parseSections('d', 'D', md).map((s) => s.heading)
  expect(got).toEqual(['Deploy', 'update packages'])
})
EOF
npx vitest run --project unit .tmp-check/old.test.ts 2>&1 | tail -6; git stash pop -q; rm -rf .tmp-check; git status --short`],
  ['payload-manual-search-words', String.raw`mkdir -p .scratch && cat > .scratch/manual-check.ts <<'EOF'
import { buildManualIndex } from '../src/lib/manual'
import { searchManual } from '../src/lib/manual-search'

const index = await buildManualIndex()
const hits = searchManual(index, 'upload alt')
console.log(hits.length, 'results for "upload alt"')
for (const h of hits.slice(0, 3)) console.log('-', h.section.docTitle, '>', h.section.heading, '|', h.snippet.slice(0, 60))
console.log('short query:', searchManual(index, 'a').length, '| empty query:', searchManual(index, '   ').length)
console.log('phrase order irrelevant:', searchManual(index, 'alt upload').length)
EOF
node --import tsx .scratch/manual-check.ts; rm -rf .scratch`],
  ['payload-manual-search-words', String.raw`cat > .scratch/manual-check.ts <<'EOF'
import { buildManualIndex } from '@/lib/manual'
import { searchManual } from '@/lib/manual-search'

const index = await buildManualIndex()
const hits = searchManual(index, 'upload alt')
console.log(hits.length, 'results for "upload alt"')
for (const h of hits.slice(0, 3)) console.log('-', h.section.docTitle, '>', h.section.heading, '|', h.snippet.slice(0, 60))
console.log('short query:', searchManual(index, 'a').length, '| empty query:', searchManual(index, '   ').length)
console.log('reverse order:', searchManual(index, 'alt upload').length)
EOF
node --import tsx .scratch/manual-check.ts; rm -rf .scratch`],
  ['payload-metadata-media-image', String.raw`mkdir -p scripts/__tests__ && cat > scripts/__tests__/scratch.test.ts <<'EOF'
import { describe, expect, it } from 'vitest'
import { mediaImage } from '../../src/lib/media'

describe('scratch', () => {
  it('resolves mediaImage', () => {
    expect(mediaImage({ id: 1, alt: 'x', updatedAt: '', createdAt: '', url: 'http://localhost:3000/media/a.webp', width: 100, height: 50 } as never)).toEqual({ url: '/media/a.webp', width: 100, height: 50, alt: 'x' })
  })
})
EOF
npx vitest run --project unit scripts/__tests__/scratch.test.ts 2>&1 | tail -20`],
  ['payload-noindex-env', String.raw`d=$(mktemp -d); cat > "$d/probe.ts" <<'EOF'
process.env.SITE_NOINDEX = 'true'
process.env.SERVER_URL = 'https://uat.example.com'
const robots = (await import(process.cwd() + '/src/app/robots.ts')).default
const { pageMetadata } = await import(process.cwd() + '/src/lib/metadata.ts')
console.log('robots(noindex):', JSON.stringify(await robots()))
console.log('page robots:', JSON.stringify((await pageMetadata({ title: 't', path: '/x' })).robots))
delete process.env.SITE_NOINDEX
console.log('robots(default):', JSON.stringify(await robots()))
console.log('page robots:', JSON.stringify((await pageMetadata({ title: 't', path: '/x' })).robots))
EOF
node --import tsx "$d/probe.ts" 2>&1 | tail -20; rm -rf "$d"`],
];

describe('the deny-to-approve list', () => {
  it.each(DENIED)('denies %s by %s', (command, rule) => {
    expect(denialFor(command, scope)?.rule).toBe(rule);
  });

  it.each(ALLOWED)('allows %s', (command) => {
    expect(denialFor(command, scope)).toBeUndefined();
  });

  it.each(EVAL_FALSE_POSITIVES)('allows the command %s was denied', (_task, command) => {
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

  it('skips heredoc bodies and splits out command substitutions, also inside double quotes', () => {
    expect(splitCommand(`d=$(mktemp -d); cat > "$d/a.ts" <<'EOF'\nimport '../x'; $(rm -rf /)\nEOF\necho "\`ls ..\`" done`)).toEqual([
      ['mktemp', '-d'],
      ['d=$(mktemp -d)'],
      ['cat', '$d/a.ts'],
      ['ls', '..'],
      ['echo', '`ls ..`', 'done'],
    ]);
  });
});

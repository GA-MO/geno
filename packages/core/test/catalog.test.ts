import { describe, expect, it } from 'vitest';
import {
  CATALOG_LIMITS,
  catalogSourceOf,
  entryProblem,
  fileOriginOf,
  fileProblem,
  installsFor,
  matchesQuery,
  pathProblem,
  planInstall,
  planUninstall,
  recordOf,
  sha256Hex,
  type CatalogEntry,
  type CatalogFile,
  type CatalogSource,
  type InstallPlan,
  type InstallRecord,
  type PlanInput,
} from '../src/catalog.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const fileOf = (path: string, text = `${path}\n`, extra: Partial<CatalogFile> = {}): CatalogFile => ({ path, sha256: sha256Hex(bytes(text)), size: bytes(text).byteLength, ...extra });
const skill = (name: string, files: readonly CatalogFile[] = [fileOf('SKILL.md')], version = '1.0.0'): CatalogEntry => ({ kind: 'skill', name, description: `The ${name} skill`, version, files });
const agent = (name: string, files: readonly CatalogFile[] = [fileOf(`${name}.md`)]): CatalogEntry => ({ kind: 'agent', name, description: `The ${name} agent`, version: '1', files });

const folder: CatalogSource = { kind: 'folder', text: '~/catalogs/team', dir: '/Users/me/catalogs/team' };
const remote: CatalogSource = { kind: 'url', text: 'https://skills.example.com/catalog.json', url: 'https://skills.example.com/catalog.json' };
const bases = { user: '/Users/me/.g-code', project: '/Users/me/ws' };
const input = (entry: CatalogEntry, over: Partial<PlanInput> = {}): PlanInput => ({ entry, source: folder, scope: 'user', bases, existing: [], records: [], occupied: false, ...over });
const planOf = (entry: CatalogEntry, over: Partial<PlanInput> = {}): InstallPlan => {
  const plan = planInstall(input(entry, over));
  if (plan.kind !== 'install') throw new Error(`expected a plan, got ${JSON.stringify(plan)}`);
  return plan;
};

describe('pathProblem', () => {
  const rows: readonly (readonly [string, string | undefined])[] = [
    ['SKILL.md', undefined],
    ['references/notes.md', undefined],
    ['scripts/install.sh', undefined],
    ['.hidden/notes.md', undefined],
    ['', 'the path is empty'],
    ['../escape.md', 'the path has a ".." segment'],
    ['references/../../escape.md', 'the path has a ".." segment'],
    ['./SKILL.md', 'the path has a "." segment'],
    ['/etc/passwd', 'the path is absolute'],
    ['C:/Windows/x', 'the path is absolute'],
    ['..\\escape', 'the path has a backslash; use /'],
    ['a//b', 'the path has an empty segment'],
    ['dir/', 'the path has an empty segment'],
    ['a\u0000b', 'the path has a control character'],
    ['a\nb', 'the path has a control character'],
    [`${'a/'.repeat(121)}x`, `the path is longer than ${CATALOG_LIMITS.pathChars} characters`],
  ];
  it.each(rows)('%j', (path, problem) => expect(pathProblem(path)).toBe(problem));
});

describe('catalogSourceOf', () => {
  it('takes an https URL of a public host, or an absolute folder', () => {
    expect(catalogSourceOf('https://skills.example.com/catalog.json', '/Users/me')).toEqual({ kind: 'url', text: 'https://skills.example.com/catalog.json', url: 'https://skills.example.com/catalog.json' });
    expect(catalogSourceOf('  /Users/me/catalogs/team/ ', '/Users/me')).toEqual({ kind: 'folder', text: '/Users/me/catalogs/team/', dir: '/Users/me/catalogs/team' });
    expect(catalogSourceOf('~/catalogs/team', '/Users/me')).toEqual({ kind: 'folder', text: '~/catalogs/team', dir: '/Users/me/catalogs/team' });
  });

  const refused: readonly (readonly [string, string])[] = [
    ['http://skills.example.com/catalog.json', 'a catalog URL must use https, not http:'],
    ['https://localhost/catalog.json', 'a catalog on this machine is a folder: write its path instead of a URL'],
    ['https://127.0.0.1/catalog.json', 'a catalog on this machine is a folder: write its path instead of a URL'],
    ['https://10.0.0.1/catalog.json', 'the URL names a private, loopback or link-local address'],
    ['https://169.254.169.254/latest', 'the URL names a private, loopback or link-local address'],
    ['https://[fe80::1]/catalog.json', 'the URL names a private, loopback or link-local address'],
    ['https://user:pw@skills.example.com/catalog.json', 'the URL carries a user name or password'],
    ['file:///Users/me/catalog', 'write a local catalog as a folder path, not a file: URL'],
    ['ftp://skills.example.com/catalog.json', 'a catalog URL must use https, not ftp:'],
    ['catalogs/team', 'a catalog folder must be an absolute path, such as ~/catalogs/team'],
    ['', 'the catalog is empty'],
  ];
  it.each(refused)('refuses %j', (text, why) => expect(catalogSourceOf(text, '/Users/me')).toEqual({ kind: 'refused', why }));

  it('does not guess a home it was not given', () => expect(catalogSourceOf('~/x', undefined).kind).toBe('refused'));
});

describe('fileOriginOf', () => {
  it('reads a folder catalog file beside the index, and a remote one against the index URL', () => {
    expect(fileOriginOf(folder, fileOf('references/notes.md'))).toEqual({ kind: 'folder', dir: folder.dir, rel: 'references/notes.md' });
    expect(fileOriginOf(remote, fileOf('SKILL.md', 'x', { url: 'deploy/SKILL.md' }))).toEqual({ kind: 'url', url: 'https://skills.example.com/deploy/SKILL.md' });
    expect(fileOriginOf(folder, fileOf('SKILL.md', 'x', { url: 'https://cdn.example.com/deploy/SKILL.md' }))).toEqual({ kind: 'url', url: 'https://cdn.example.com/deploy/SKILL.md' });
  });

  it('refuses a source outside the catalog, or one that is not https on a public host', () => {
    expect(fileOriginOf(folder, fileOf('SKILL.md', 'x', { url: '../other/SKILL.md' }))).toEqual({ kind: 'refused', why: '../other/SKILL.md: the path has a ".." segment' });
    expect(fileOriginOf(folder, fileOf('SKILL.md', 'x', { url: '/etc/passwd' }))).toEqual({ kind: 'refused', why: '/etc/passwd: the path is absolute' });
    expect(fileOriginOf(remote, fileOf('SKILL.md', 'x', { url: 'http://skills.example.com/SKILL.md' })).kind).toBe('refused');
    expect(fileOriginOf(remote, fileOf('SKILL.md', 'x', { url: 'https://192.168.1.4/SKILL.md' })).kind).toBe('refused');
    expect(fileOriginOf(remote, fileOf('SKILL.md', 'x', { url: 'file:///etc/passwd' })).kind).toBe('refused');
  });
});

describe('fileProblem', () => {
  const file = fileOf('SKILL.md', 'the real text\n');
  it('passes the bytes the catalog lists', () => expect(fileProblem(file, bytes('the real text\n'))).toBeUndefined());
  it('refuses other bytes of the same size', () => expect(fileProblem(file, bytes('the fake text\n'))).toMatch(/^SKILL\.md does not match its sha256 in the catalog/));
  it('refuses a size other than the listed one', () => expect(fileProblem(file, bytes('the real text, longer\n'))).toBe('SKILL.md is 22 bytes, not the 14 the catalog lists'));
  it('refuses a file over the cap even when its hash matches', () => {
    const big = new Uint8Array(CATALOG_LIMITS.fileBytes + 1);
    expect(fileProblem({ path: 'big.bin', sha256: sha256Hex(big) }, big)).toBe('big.bin is larger than the 1.0 MB a file may be');
  });
});

describe('entryProblem', () => {
  const rows: readonly (readonly [string, CatalogEntry, string | undefined])[] = [
    ['a skill with SKILL.md', skill('deploy', [fileOf('SKILL.md'), fileOf('scripts/install.sh')]), undefined],
    ['an agent of one file', agent('reviewer'), undefined],
    ['no SKILL.md', skill('deploy', [fileOf('README.md')]), 'it has no SKILL.md'],
    ['skill.md in the wrong case', skill('deploy', [fileOf('skill.md')]), 'it has no SKILL.md'],
    ['an agent of two files', agent('reviewer', [fileOf('reviewer.md'), fileOf('notes.md')]), 'an agent definition is one file, reviewer.md'],
    ['an agent file named otherwise', agent('reviewer', [fileOf('other.md')]), 'an agent definition is one file, reviewer.md'],
    ['an upper-case name', skill('Deploy'), 'its name must be lowercase letters, digits and single hyphens, at most 64 characters'],
    ['a name with a slash', skill('../deploy'), 'its name must be lowercase letters, digits and single hyphens, at most 64 characters'],
    ['a traversal path', skill('deploy', [fileOf('SKILL.md'), fileOf('../../.zshrc')]), '../../.zshrc: the path has a ".." segment'],
    ['a path twice, in two cases', skill('deploy', [fileOf('SKILL.md'), fileOf('Notes.md'), fileOf('notes.md')]), 'notes.md is listed twice'],
    ['a bad hash', skill('deploy', [{ path: 'SKILL.md', sha256: 'abc' }]), 'SKILL.md: its sha256 must be 64 lowercase hex digits'],
    ['a listed size over the cap', skill('deploy', [fileOf('SKILL.md', 'x', { size: CATALOG_LIMITS.fileBytes + 1 })]), 'SKILL.md is larger than the 1.0 MB a file may be'],
    [
      'files over the entry cap',
      skill('deploy', [fileOf('SKILL.md'), ...Array.from({ length: 6 }, (_, i) => fileOf(`big-${i}.bin`, 'x', { size: CATALOG_LIMITS.fileBytes }))]),
      'its files add up to more than 5.0 MB',
    ],
    ['too many files', skill('deploy', [fileOf('SKILL.md'), ...Array.from({ length: CATALOG_LIMITS.files }, (_, i) => fileOf(`f${i}.md`))]), `it lists more than ${CATALOG_LIMITS.files} files`],
    ['no files', skill('deploy', []), 'it lists no files'],
    ['no description', { ...skill('deploy'), description: ' ' }, 'it has no description'],
  ];
  it.each(rows)('%s', (_, entry, problem) => expect(entryProblem(entry)).toBe(problem));
});

describe('planInstall', () => {
  it('writes a user skill into its own folder under ~/.g-code/skills', () => {
    const plan = planOf(skill('deploy', [fileOf('SKILL.md'), fileOf('scripts/install.sh')]));
    expect(plan.target).toBe('/Users/me/.g-code/skills/deploy');
    expect(plan.owns).toBe('/Users/me/.g-code/skills/deploy');
    expect(plan.writes.map((w) => [w.dest, w.origin])).toEqual([
      ['/Users/me/.g-code/skills/deploy/SKILL.md', { kind: 'folder', dir: folder.dir, rel: 'SKILL.md' }],
      ['/Users/me/.g-code/skills/deploy/scripts/install.sh', { kind: 'folder', dir: folder.dir, rel: 'scripts/install.sh' }],
    ]);
  });

  it("writes a project agent as one file in the workspace's .g-code, owning no folder", () => {
    const plan = planOf(agent('reviewer'), { scope: 'project' });
    expect(plan.target).toBe('/Users/me/ws/.g-code/agents/reviewer.md');
    expect(plan.owns).toBeUndefined();
    expect(plan.writes.map((w) => w.dest)).toEqual(['/Users/me/ws/.g-code/agents/reviewer.md']);
  });

  it('refuses a name another skill already has, wherever it is', () => {
    const existing = [{ kind: 'skill' as const, name: 'deploy', path: '.claude/skills/deploy/SKILL.md' }];
    expect(planInstall(input(skill('deploy'), { existing }))).toEqual({ kind: 'refused', why: 'a skill named deploy already exists at .claude/skills/deploy/SKILL.md' });
    expect(planInstall(input(agent('deploy'), { existing })).kind, 'an agent of the same name is no clash').toBe('install');
    expect(planInstall(input(agent('explore'), { existing: [{ kind: 'agent', name: 'explore', path: 'built-in' }] }))).toEqual({ kind: 'refused', why: 'an agent named explore already exists at built-in' });
  });

  it('never overwrites a target Geno did not install', () => {
    expect(planInstall(input(skill('deploy'), { occupied: true }))).toEqual({ kind: 'refused', why: '/Users/me/.g-code/skills/deploy already exists, and Geno does not overwrite files it did not install' });
  });

  it('treats the same entry installed again as done, and another version as needing an uninstall first', () => {
    const entry = skill('deploy');
    const record = recordOf(planOf(entry), 'i1', new Date('2026-10-07T00:00:00Z'));
    expect(planInstall(input(entry, { records: [record], occupied: true }))).toEqual({ kind: 'installed', record });
    const next = skill('deploy', [fileOf('SKILL.md', 'v2\n')], '2.0.0');
    expect(planInstall(input(next, { records: [record], occupied: true }))).toEqual({
      kind: 'refused',
      why: 'deploy 1.0.0 from ~/catalogs/team is already installed at /Users/me/.g-code/skills/deploy; uninstall it first',
    });
  });

  it("finds a project install an older Geno made in .claude: the same entry is done, another version names where it is", () => {
    const entry = skill('deploy');
    const old = '/Users/me/ws/.claude/skills/deploy';
    const record: InstallRecord = { ...recordOf(planOf(entry, { scope: 'project' }), 'i0', new Date('2026-10-07T00:00:00Z')), target: old, owns: old, files: [{ path: `${old}/SKILL.md`, sha256: sha256Hex(bytes('SKILL.md\n')) }] };
    const existing = [{ kind: 'skill' as const, name: 'deploy', path: '.claude/skills/deploy/SKILL.md' }];
    expect(planInstall(input(entry, { scope: 'project', records: [record], existing }))).toEqual({ kind: 'installed', record });
    expect(planInstall(input(skill('deploy', [fileOf('SKILL.md', 'v2\n')], '2.0.0'), { scope: 'project', records: [record], existing }))).toEqual({
      kind: 'refused',
      why: `deploy 1.0.0 from ~/catalogs/team is already installed at ${old}; uninstall it first`,
    });
  });

  it('refuses a traversal or a refused URL before anything is fetched', () => {
    expect(planInstall(input(skill('deploy', [fileOf('SKILL.md'), fileOf('../../../.ssh/authorized_keys')])))).toEqual({
      kind: 'refused',
      why: 'deploy: ../../../.ssh/authorized_keys: the path has a ".." segment',
    });
    expect(planInstall(input(skill('deploy', [fileOf('SKILL.md', 'x', { url: 'https://10.0.0.8/SKILL.md' })]), { source: remote }))).toEqual({
      kind: 'refused',
      why: 'SKILL.md: the URL names a private, loopback or link-local address',
    });
  });

  it('records each file it writes with its hash, and the workspace of a project install', () => {
    const plan = planOf(skill('deploy'), { scope: 'project' });
    expect(recordOf(plan, 'i2', new Date('2026-10-07T00:00:00Z'))).toEqual({
      id: 'i2',
      kind: 'skill',
      name: 'deploy',
      description: 'The deploy skill',
      version: '1.0.0',
      scope: 'project',
      workspace: '/Users/me/ws',
      catalog: '~/catalogs/team',
      target: '/Users/me/ws/.g-code/skills/deploy',
      owns: '/Users/me/ws/.g-code/skills/deploy',
      files: [{ path: '/Users/me/ws/.g-code/skills/deploy/SKILL.md', sha256: sha256Hex(bytes('SKILL.md\n')) }],
      installedAt: '2026-10-07T00:00:00.000Z',
    });
  });
});

describe('planUninstall', () => {
  const record = recordOf(planOf(skill('deploy', [fileOf('SKILL.md'), fileOf('references/a/notes.md'), fileOf('scripts/install.sh')])), 'i1', new Date());
  const [main, notes, script] = record.files.map((f) => f.path) as [string, string, string];

  it('removes the files as Geno wrote them, keeps edited ones, and empties folders deepest first', () => {
    expect(planUninstall(record, [{ path: main, state: 'same' }, { path: notes, state: 'changed' }, { path: script, state: 'missing' }])).toEqual({
      remove: [main],
      keep: [notes],
      dirs: ['/Users/me/.g-code/skills/deploy/references/a', '/Users/me/.g-code/skills/deploy/references', '/Users/me/.g-code/skills/deploy/scripts', '/Users/me/.g-code/skills/deploy'],
    });
  });

  it('removes nothing outside the folder the install owns, even if the manifest says so', () => {
    const forged: InstallRecord = { ...record, files: [...record.files, { path: '/Users/me/.zshrc', sha256: 'x' }] };
    const plan = planUninstall(forged, forged.files.map((f) => ({ path: f.path, state: 'same' as const })));
    expect(plan.remove).not.toContain('/Users/me/.zshrc');
    expect(plan.dirs.every((dir) => dir.startsWith('/Users/me/.g-code/skills/deploy'))).toBe(true);
  });

  it('removes an agent file but never its shared folder', () => {
    const one = recordOf(planOf(agent('reviewer')), 'i3', new Date());
    expect(planUninstall(one, [{ path: one.target, state: 'same' }])).toEqual({ remove: [one.target], keep: [], dirs: [] });
    const forged: InstallRecord = { ...one, files: [...one.files, { path: '/Users/me/ws/.g-code/agents/other.md', sha256: 'x' }] };
    expect(planUninstall(forged, forged.files.map((f) => ({ path: f.path, state: 'same' as const }))).remove).toEqual([one.target]);
  });
});

describe('search and scope', () => {
  it('matches every word in the name or description, ignoring case', () => {
    expect(matchesQuery(skill('deploy'), '')).toBe(true);
    expect(matchesQuery(skill('deploy'), 'DEPLOY skill')).toBe(true);
    expect(matchesQuery(skill('deploy'), 'deploy agent')).toBe(false);
  });

  it('applies user installs everywhere, and project installs only in their workspace', () => {
    const user = recordOf(planOf(skill('a')), 'u', new Date());
    const here = recordOf(planOf(skill('b'), { scope: 'project' }), 'p', new Date());
    const there = recordOf(planOf(skill('c'), { scope: 'project', bases: { ...bases, project: '/Users/me/other' } }), 'o', new Date());
    expect(installsFor([user, here, there], '/Users/me/ws').map((r) => r.id)).toEqual(['u', 'p']);
  });
});

import { describe, expect, it } from 'vitest';
import { asSessionId, replayMessages, renderEnvironment, type Environment, type Session, type TurnEvent } from '../src/index.js';

const session: Session = {
  id: asSessionId('s-1'),
  createdAt: '2026-10-08T03:00:00.000Z',
  workspace: '/Users/dev/shop',
  provider: 'modelstudio',
  model: 'qwen3.8-flash',
  effort: 'medium',
};

const mac: Environment = {
  date: '2026-10-08',
  platform: 'darwin',
  osVersion: 'Darwin 27.0.0',
  loginShell: 'zsh',
  scratchpad: '/private/var/folders/x/T/gcode-sessions/s-1',
  git: { branch: 'main', status: [' M src/a.ts', '?? notes.md'], moreStatus: 0, commits: ['683017b Keep the tag list private', '795f945 Test T-AGENT-02'] },
  project: {
    packageManager: 'pnpm 11.3.0',
    scripts: [
      ['dev', 'next dev'],
      ['test', 'vitest run'],
    ],
    otherScripts: ['seed', 'storybook'],
    versions: [
      ['next', '15.1.0'],
      ['react', '19.0.0'],
    ],
  },
};

const text = (messages: ReturnType<typeof replayMessages>, at: number): string[] => {
  const content = messages[at]!.content;
  return typeof content === 'string' ? [content] : content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
};

describe('renderEnvironment', () => {
  it('names every fact the model cannot infer, and says the snapshot will not update', () => {
    const lines = renderEnvironment(mac, session).split('\n');
    expect(lines[0]).toMatch(/^\[Geno\] .*recorded when this session started.*will not update/);
    expect(lines).toContain(' - Workspace: /Users/dev/shop');
    expect(lines).toContain(' - Is a git repository: true');
    expect(lines).toContain(' - OS version: Darwin 27.0.0');
    expect(lines).toContain(' - Date: 2026-10-08, the local date when this session started. Run date for the current time.');
    expect(lines).toContain(' - Model: qwen3.8-flash on Model Studio');
    expect(lines.find((line) => line.startsWith(' - Platform:'))).toMatch(/darwin.*BSD.*sed -i ''/);
    expect(lines.find((line) => line.startsWith(' - Shell:'))).toMatch(/bash -c .*login shell is zsh/);
    expect(lines.find((line) => line.startsWith(' - Scratchpad directory:'))).toMatch(/^ - Scratchpad directory: \/private\/var\/folders\/x\/T\/gcode-sessions\/s-1\. .*no approval/);
  });

  it('lists the package manager, the key scripts, the rest by name, and the installed versions', () => {
    const rendered = renderEnvironment(mac, session);
    expect(rendered).toContain(['Package manager: pnpm 11.3.0', 'Scripts in package.json:', ' - dev: next dev', ' - test: vitest run', 'Other scripts: seed, storybook', 'Versions: next 15.1.0, react 19.0.0'].join('\n'));
  });

  it('gives the git snapshot last, marked as a snapshot, with the status and the recent commits', () => {
    const rendered = renderEnvironment(mac, session);
    const git = rendered.slice(rendered.indexOf('Git status'));
    expect(git.split('\n')[0]).toMatch(/snapshot.*will not update/);
    expect(git).toContain(['Current branch: main', 'Status:', ' M src/a.ts', '?? notes.md', 'Recent commits:', '683017b Keep the tag list private', '795f945 Test T-AGENT-02'].join('\n'));
  });

  it('says clean, detached and how many status lines it left out', () => {
    const clean = renderEnvironment({ ...mac, git: { branch: undefined, status: [], moreStatus: 0, commits: [] } }, session);
    expect(clean).toContain('Current branch: none (detached HEAD)\nStatus: clean\nRecent commits: none');
    const long = renderEnvironment({ ...mac, git: { ...mac.git!, moreStatus: 40 } }, session);
    expect(long).toContain('?? notes.md\n(40 more lines; run git status to see them)');
  });

  it("says a lane session's lane and warns that the stash stack is shared, and says nothing of lanes outside one", () => {
    const lane = { name: 'fix-login', branch: 'geno/fix-login', main: '/Users/dev/shop' };
    const lines = renderEnvironment({ ...mac, lane }, { ...session, workspace: '/Users/dev/shop/.geno/worktrees/fix-login' }).split('\n');
    const line = lines.find((l) => l.startsWith(' - Lane:'));
    expect(line).toMatch(/^ - Lane: fix-login, a git worktree on branch geno\/fix-login; the main checkout is \/Users\/dev\/shop\./);
    expect(line).toMatch(/stash stack is shared by the main checkout and every lane/);
    expect(line).toMatch(/Never run a bare git stash or git stash pop/);
    expect(line).toMatch(/git stash apply <sha>/);
    expect(renderEnvironment(mac, session)).not.toMatch(/Lane:|stash/);
  });

  it('leaves out what a workspace lacks: no git section outside a repository, no project section without package.json, no BSD note off macOS', () => {
    const bare = renderEnvironment({ ...mac, platform: 'linux', osVersion: 'Linux 6.8.0', loginShell: undefined, git: undefined, project: undefined }, session);
    expect(bare).toContain(' - Is a git repository: false');
    expect(bare).not.toMatch(/Git status|Package manager|BSD/);
    expect(bare).toContain(' - Platform: linux');
    expect(bare.split('\n').find((line) => line.startsWith(' - Shell:'))).not.toMatch(/login shell/);
  });
});

describe('the environment in the conversation', () => {
  const start = (environment?: Environment): TurnEvent => ({
    kind: 'session-start',
    session,
    context: { instructions: [{ path: 'AGENTS.md', text: 'Use pnpm.' }], rules: [], skills: [] },
    ...(environment === undefined ? {} : { environment }),
  });
  const prompt: TurnEvent = { kind: 'user', seq: 1, at: '2026-10-08T03:00:01.000Z', content: 'What day is it?' };

  it('opens the first user message after the loaded context and before the prompt', () => {
    const blocks = text(replayMessages([start(mac), prompt]), 0);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain('<project_instructions path="AGENTS.md">');
    expect(blocks[1]).toBe(renderEnvironment(mac, session));
    expect(blocks[2]).toBe('What day is it?');
  });

  it('is absent from a log written before sessions recorded one', () => {
    const blocks = text(replayMessages([start(), prompt]), 0);
    expect(blocks).toHaveLength(2);
    expect(blocks.join('\n')).not.toContain('Scratchpad');
  });

  it('opens a session with no loaded context too', () => {
    const bare: TurnEvent = { kind: 'session-start', session, environment: mac };
    expect(text(replayMessages([bare, prompt]), 0)).toEqual([renderEnvironment(mac, session), 'What day is it?']);
  });
});

// Each run's own HOME, so no file of the user's (CLAUDE.md, plugins, hooks, settings) reaches a request. A case gets
// only what it names: `plugins: ['pstack']` installs a fake pstack plugin whose poteto-mode skill is long enough to
// pass the spill limit (ISSUES.md G-06) and names Claude Code tools that geno-tools.md maps (P-08).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const homeEnv = (home) => ({ HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GCODE_HOME: path.join(home, '.gcode') });

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const PRINCIPLES = [
  ['Laziness', 'Prefer deleting code to adding it. The smallest change that solves the problem wins.'],
  ['Foundational thinking', 'Name the data shape before you write logic. Decide what the core types are and who owns them.'],
  ['Prove it works', 'Verify against the real artifact: run the feature, read the actual value, inspect the diff.'],
  ['Fix root causes', 'Reproduce first. Ask why until you reach the cause, then fix that, not the symptom.'],
  ['Test behavior', 'Assert the observable result. A test that would pass with the bug in place is not a test.'],
  ['Minimize reader load', 'Collapse one-caller wrappers, shrink mutable scope, and keep names honest.'],
];

function potetoSkill() {
  const sections = [];
  for (let round = 1; round <= 9; round++) {
    for (const [name, rule] of PRINCIPLES) {
      sections.push(`### ${name} (${round})\n\n${rule} Apply it at every step of the playbook below, and name it in your reply when it changed a decision. When the task is small, keep the reply small too; a long survey is not a better answer. Use the Agent tool for a parallel search, TaskCreate for the todo list, and AskUserQuestion only for a real product choice.\n`);
    }
  }
  return `---\nname: poteto-mode\ndescription: poteto's agent style for concise, detailed responses and verified work.\n---\n# Poteto mode\n\nOpen a todo list with TaskCreate whose first items are the playbook's steps. Read the principle skills you apply.\n\n## Feature playbook\n\n1. Name the data shape.\n2. Write the smallest change.\n3. Test the behavior.\n4. Run it for real and report what you saw.\n\n## Principles\n\n${sections.join('\n')}\n## Writing the reply\n\nShort declarative sentences. Every claim carries its evidence.\n`;
}

/** Writes a fresh HOME for one run and returns its environment. */
export function prepareHome(home, spec) {
  rmSync(home, { recursive: true, force: true });
  write(path.join(home, '.gitconfig'), '[user]\n\tname = Dev\n\temail = dev@example.com\n[commit]\n\tgpgsign = false\n');
  write(path.join(home, '.claude', 'settings.json'), '{}\n');
  if ((spec.plugins ?? []).includes('pstack')) {
    const root = path.join(home, '.claude', 'plugins', 'cache', 'pstack', 'pstack', '0.0.0');
    write(path.join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'pstack' })}\n`);
    write(path.join(root, 'skills', 'poteto-mode', 'SKILL.md'), potetoSkill());
    write(path.join(root, 'skills', 'how', 'SKILL.md'), '---\nname: how\ndescription: Explain how a subsystem works before changing it.\n---\n# How\n\nRead the code paths end to end and explain the runtime flow.\n');
    write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), `${JSON.stringify({ version: 2, plugins: { 'pstack@pstack': [{ scope: 'user', installPath: root }] } }, null, 2)}\n`);
  }
  return homeEnv(home);
}

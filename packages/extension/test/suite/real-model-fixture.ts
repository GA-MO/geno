/** The real-model campaign's Layer B workspace, shared by the suite inside VS Code and the test that launches it. */

export const MCP_SERVER = 'wsfake';

export const FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify({ name: 'tiny-shop', version: '0.1.0', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  'README.md': '# tiny-shop\n\nPrice and user helpers. Run the tests with `npm test`.\n',
  'src/money.ts': "export function formatPrice(cents: number): string {\n  return `$${cents / 100}`;\n}\n",
  'src/slug.ts': "export function slugify(title: string): string {\n  return title.trim().toLowerCase().replace(/ /g, '-');\n}\n",
  'src/user.js': "const USERS = new Map([[1, { id: 1, name: 'Ada' }]]);\n\nexport function getUser(id) {\n  return USERS.get(id) ?? null;\n}\n",
  'src/routes.js': "import { getUser } from './user.js';\n\nexport const userRoute = (id) => getUser(Number(id)) ?? { error: 'not found' };\n",
  'src/profile.js': "import { getUser } from './user.js';\n\nexport const title = (id) => `Profile of ${getUser(id)?.name ?? 'nobody'}`;\n",
  'test/money.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatPrice } from '../src/money.ts';\ntest('two decimals', () => assert.equal(formatPrice(1250), '$12.50'));\n",
  'build/bundle.js': '// old build output\n',
  'dist/out.js': '// old dist output\n',
  '.g-code/settings.json': `${JSON.stringify({ agentTool: ['ask'] }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
};

export const STEPS = [
  'B10-thai-and-working',
  'B01-ask-allow',
  'B02-ask-deny',
  'B03-no-and-tell',
  'B04-keep-undo',
  'B05-lanes',
  'B07-subagent-row',
  'B08-mcp-banner',
  'B09-stop-and-resume-thai',
] as const;

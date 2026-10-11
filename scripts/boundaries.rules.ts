import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLES } from '../packages/extension/build.mjs';

/**
 * The dependency boundaries that keep each part of Geno cheap to lift into a library. `scripts/boundaries.ts`
 * checks them, and `pnpm test` runs it. Paths are repo-relative; an import is checked against the file it resolves to.
 */
export type Boundaries = {
  readonly sources: readonly string[];
  /** Code under `from` imports nothing under `mayNotImport`, and, when `nodeBuiltins` is set, only those Node modules. */
  readonly layers: readonly { readonly name: string; readonly from: string; readonly mayNotImport: readonly string[]; readonly nodeBuiltins?: readonly string[] }[];
  /** Code under `inside` reaches the rest of `within` only through the files in `through`. */
  readonly gates: readonly { readonly name: string; readonly inside: string; readonly within: string; readonly through: readonly string[] }[];
  /**
   * Every file a bundle's entries reach by value imports runs in a browser, so it imports neither `vscode` nor Node,
   * nor the packages in `leavesOut`.
   */
  readonly bundles: readonly {
    readonly name: string;
    readonly runsIn: string;
    readonly entries: readonly string[];
    readonly leavesOut?: { readonly packages: readonly string[]; readonly why: string };
  }[];
  /** Single imports allowed across a rule, each with the reason a fix is not small. */
  readonly exceptions: readonly { readonly from: string; readonly to: string; readonly reason: string }[];
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The extension's browser bundles, read from its build, so a new webview bundle is checked too. */
const webviewEntries = BUNDLES.filter((bundle) => bundle.platform === 'browser').flatMap((bundle) =>
  Object.values(bundle.entryPoints ?? {}).map((entry) => path.relative(repo, typeof entry === 'string' ? entry : entry.in).split(path.sep).join('/')),
);

const DOCS_ISLANDS = 'packages/docs/src/components';
const docsIslandEntries = readdirSync(path.join(repo, DOCS_ISLANDS))
  .filter((name) => name.endsWith('.tsx'))
  .map((name) => `${DOCS_ISLANDS}/${name}`);

export const BOUNDARIES: Boundaries = {
  sources: ['packages/core/src', 'packages/engine/src', 'packages/extension/src', 'packages/docs/src'],
  layers: [
    {
      name: 'core-is-pure',
      from: 'packages/core',
      mayNotImport: ['packages/engine', 'packages/extension', 'packages/docs'],
      nodeBuiltins: ['path', 'crypto'],
    },
    { name: 'engine-without-extension', from: 'packages/engine', mayNotImport: ['packages/extension', 'packages/docs'] },
    { name: 'extension-without-docs', from: 'packages/extension', mayNotImport: ['packages/docs'] },
    { name: 'docs-read-sources-as-text', from: 'packages/docs', mayNotImport: ['packages/core', 'packages/engine', 'packages/extension'] },
  ],
  gates: [
    {
      name: 'mcp-gate',
      inside: 'packages/engine/src/mcp',
      within: 'packages/engine',
      through: [
        'packages/engine/src/store.ts',
        'packages/engine/src/child-env.ts',
        'packages/engine/src/tools/context.ts',
        // The approval glue: modes, settling a permission request and the denial text.
        'packages/engine/src/tools/agent.ts',
        // Stores and describes the images MCP tools return, as every tool's images are.
        'packages/engine/src/attachments.ts',
        // EngineError, the base class of the errors the engine reports to the user.
        'packages/engine/src/errors.ts',
        // `gcode mcp list` and `gcode mcp trust` plug into the CLI's command table.
        'packages/engine/src/command.ts',
        'packages/engine/src/workspace.ts',
        // The installed Claude Code plugins, whose `.mcp.json` servers join the session's.
        'packages/engine/src/plugins.ts',
      ],
    },
  ],
  bundles: [
    { name: 'webview-in-browser', runsIn: 'webview', entries: webviewEntries },
    {
      name: 'docs-islands-without-elk',
      runsIn: "reader's browser",
      entries: docsIslandEntries,
      leavesOut: { packages: ['elkjs'], why: 'the build lays the system map out, so the page ships without the layout engine' },
    },
  ],
  exceptions: [
    {
      from: 'packages/core/src/browser.ts',
      to: 'node:url',
      reason:
        'fileURLToPath decides whether a file: URL the agent opens lies inside the workspace. It is pure string parsing, ' +
        'but rewriting its decoding and refusal rules by hand would weaken a security check.',
    },
  ],
};

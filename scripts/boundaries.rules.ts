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
  /** Every file a bundle's entries reach by value imports runs in a browser, so it imports neither `vscode` nor Node. */
  readonly bundles: readonly { readonly name: string; readonly runsIn: string; readonly entries: readonly string[] }[];
  /** Single imports allowed across a rule, each with the reason a fix is not small. */
  readonly exceptions: readonly { readonly from: string; readonly to: string; readonly reason: string }[];
};

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The extension's browser bundles, read from its build, so a new webview bundle is checked too. */
const webviewEntries = BUNDLES.filter((bundle) => bundle.platform === 'browser').flatMap((bundle) =>
  Object.values(bundle.entryPoints ?? {}).map((entry) => path.relative(repo, typeof entry === 'string' ? entry : entry.in).split(path.sep).join('/')),
);

export const BOUNDARIES: Boundaries = {
  sources: ['packages/core/src', 'packages/engine/src', 'packages/extension/src', 'packages/web/src'],
  layers: [
    {
      name: 'core-is-pure',
      from: 'packages/core',
      mayNotImport: ['packages/engine', 'packages/extension', 'packages/web'],
      nodeBuiltins: ['path', 'crypto'],
    },
    { name: 'engine-without-extension', from: 'packages/engine', mayNotImport: ['packages/extension', 'packages/web'] },
    // The web host runs the extension's chat host; the extension never depends on how it is served.
    { name: 'extension-without-web', from: 'packages/extension', mayNotImport: ['packages/web'] },
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
    { name: 'web-client-in-browser', runsIn: 'browser', entries: ['packages/web/src/client.ts'] },
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

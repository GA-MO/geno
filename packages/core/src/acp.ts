/** g-code's additions to the Agent Client Protocol, shared by the engine and the extension. docs/e12.md maps every flow. */

/** Extension method, sent by the engine: the editor's diagnostics for some files. */
export const DIAGNOSTICS_METHOD = '_gcode/diagnostics';

/** Key in the client capabilities' `_meta`, true when the client answers DIAGNOSTICS_METHOD. */
export const DIAGNOSTICS_CAPABILITY = 'gcode/diagnostics';

/** Key in fs/write_text_file's `_meta`: the hash of the text the write was computed from, null for a new file. */
export const BASE_HASH_META = 'gcode/baseHash';

/** The JSON-RPC error a client answers fs/write_text_file with when the file no longer holds that text. */
export const STALE_BASE_ERROR = { code: -32010, reason: 'stale-base' } as const;

export const SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type DiagnosticsRequest = { readonly sessionId: string; readonly paths: readonly string[] };

/** One problem the editor reports. `line` and `character` count from 1. */
export type EditorDiagnostic = {
  readonly path: string;
  readonly line: number;
  readonly character: number;
  readonly severity: Severity;
  readonly message: string;
  readonly source: string | null;
};

export type DiagnosticsResponse = { readonly diagnostics: readonly EditorDiagnostic[] };

export function formatDiagnostics(diagnostics: readonly EditorDiagnostic[], show: (path: string) => string): string {
  if (diagnostics.length === 0) return 'The editor reports no problems in the files you read or edited.';
  const lines = diagnostics.map(
    (d) => `${show(d.path)}:${d.line}:${d.character} ${d.severity}: ${d.message}${d.source === null ? '' : ` (${d.source})`}`,
  );
  return `The editor reports these problems in the files you read or edited:\n${lines.join('\n')}`;
}

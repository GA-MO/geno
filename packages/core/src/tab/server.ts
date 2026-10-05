/** The Tab model server's lifecycle, as the status bar shows it. */
export type TabServerState =
  | { readonly kind: 'off' }
  | { readonly kind: 'starting' }
  /** `owned` is false when a server was already answering, such as one started by scripts/tab-server.sh. */
  | { readonly kind: 'ready'; readonly owned: boolean }
  | { readonly kind: 'failed'; readonly reason: string };

export const DEFAULT_TAB_MODEL_FILE = 'qwen2.5-coder-1.5b-q8_0.gguf';

/** scripts/tab-server.sh's flags; docs/tab-model.md says why each one is set. */
export function llamaServerArgs(model: string, port: number): string[] {
  const alias = (model.split('/').at(-1) ?? model).replace(/\.gguf$/, '');
  return [
    ...['--model', model, '--alias', alias, '--host', '127.0.0.1', '--port', String(port)],
    ...['--n-gpu-layers', '99', '--flash-attn', 'on', '--ctx-size', '4096', '--parallel', '1', '--cache-reuse', '256'],
    '--no-webui',
  ];
}

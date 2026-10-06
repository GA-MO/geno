import * as vscode from 'vscode';
import { z } from 'zod';
import { markSeen, type SeenMarkers } from './lanes-model.js';

const stored = z.record(z.string(), z.number());

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The markers, in a file in the extension's workspace storage so they survive a window reload. A file rather than
 * workspaceState, for the reason `sessionMemory` gives.
 */
export function seenStore(storage: vscode.Uri | undefined) {
  let markers: SeenMarkers = {};
  let writing = Promise.resolve();
  const file = storage === undefined ? undefined : vscode.Uri.joinPath(storage, 'seen.json');
  return {
    async load(): Promise<void> {
      if (file === undefined) return;
      const text = await vscode.workspace.fs.readFile(file).then((bytes) => new TextDecoder().decode(bytes), () => '{}');
      const parsed = stored.safeParse(parsedJson(text));
      if (parsed.success) for (const [id, at] of Object.entries(parsed.data)) markers = markSeen(markers, id, at);
    },
    current: (): SeenMarkers => markers,
    /** Whether the marker moved. */
    mark(id: string, at: number): boolean {
      const next = markSeen(markers, id, at);
      if (next === markers) return false;
      markers = next;
      if (file !== undefined && storage !== undefined) {
        const text = JSON.stringify(markers);
        writing = writing
          .then(async () => {
            await vscode.workspace.fs.createDirectory(storage);
            await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
          })
          .catch(() => {});
      }
      return true;
    },
  };
}

export type SeenStore = ReturnType<typeof seenStore>;

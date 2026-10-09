import { describe, expect, it } from 'vitest';
import type { ShownFiles, ToolResultEvent } from '@g-code/core';
import { toolResultUpdate } from '../../engine/src/session-replay.js';
import { updateActions } from '../src/chat/session-updates.js';
import { shownPaths } from '../src/chat/show-files-model.js';
import { reduce } from '../src/chat/transcript.js';
import type { Transcript } from '../src/chat/messages.js';

const SHOWN: ShownFiles = {
  caption: 'Before and after',
  layout: 'single',
  files: [
    { kind: 'shown', given: 'before.png', path: '/w/before.png', name: 'before.png', bytes: 2048, show: 'image' },
    { kind: 'refused', given: '.env', reason: '.env is off limits to show_files' },
  ],
};

const result = (shown: ShownFiles | undefined): ToolResultEvent => ({
  kind: 'tool-result',
  seq: 4,
  at: '2026-10-10T00:00:00.000Z',
  toolUseId: 'tu_show',
  name: 'show_files',
  status: 'ok',
  output: 'Shown to the user in the chat',
  ...(shown === undefined ? {} : { shown }),
});

describe('a show_files result on its way to the panel', () => {
  it('reaches the step with the card the engine logged, as live and replayed results do', () => {
    const [action] = updateActions(toolResultUpdate(result(SHOWN)), (file) => file);
    expect(action).toMatchObject({ type: 'tool', id: 'tu_show', status: 'completed', shown: SHOWN });
    const [plain] = updateActions(toolResultUpdate(result(undefined)), (file) => file);
    expect(plain).not.toHaveProperty('shown');
  });

  it('lets the panel open the files the transcript showed, and only those', () => {
    let transcript: Transcript = { model: 'm', turns: [] };
    transcript = reduce(transcript, { type: 'turn-start', id: 't0', at: 1, prompt: 'Show me', mode: 'ask' });
    transcript = reduce(transcript, { type: 'tool', id: 'tu_show', at: 2, name: 'show_files', target: 'before.png', toolKind: 'other', status: 'running' });
    for (const action of updateActions(toolResultUpdate(result(SHOWN)), (file) => file)) transcript = reduce(transcript, action);
    expect(shownPaths(transcript)).toEqual(['/w/before.png']);
  });
});

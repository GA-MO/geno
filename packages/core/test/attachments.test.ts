import { describe, expect, it } from 'vitest';
import {
  asSessionId,
  asSha256,
  attachmentFileName,
  buildRequest,
  fitWithin,
  imageInfo,
  MAX_IMAGES,
  MAX_MESSAGE_BYTES,
  overLimit,
  refusalOf,
  replayMessages,
  type FileAttachment,
  type ImageAttachment,
  type Session,
  type TurnEvent,
} from '../src/index.js';
import { twoColorPng } from './png.js';

const session: Session = {
  id: asSessionId('s1'),
  createdAt: '2026-10-05T00:00:00.000Z',
  workspace: '/work/ws',
  provider: 'modelstudio',
  model: 'qwen3.8-flash',
  effort: 'medium',
};
const at = '2026-10-05T00:00:01.000Z';
const start: TurnEvent = { kind: 'session-start', session };

const shot: ImageAttachment = { kind: 'image', sha256: asSha256('a'.repeat(64)), mediaType: 'image/png', name: 'shot.png', bytes: 120, width: 4, height: 2 };
const notes: FileAttachment = { kind: 'file', sha256: asSha256('b'.repeat(64)), mediaType: 'text/plain', name: 'notes.md', bytes: 12, path: '/work/ws/docs/notes.md' };
const outside: FileAttachment = { ...notes, sha256: asSha256('c'.repeat(64)), name: 'todo.txt', path: '/elsewhere/todo.txt' };
const pasted: FileAttachment = { ...notes, sha256: asSha256('d'.repeat(64)), name: 'clip.txt', path: undefined };

const stored = new Map([
  [shot.sha256, 'iVBORbase64'],
  [notes.sha256, 'first\nsecond\n'],
  [outside.sha256, 'x\n'],
  [pasted.sha256, ''],
]);

describe('fitWithin', () => {
  it('keeps an image whose long side is within the limit', () => {
    expect(fitWithin(1568, 900)).toEqual({ width: 1568, height: 900 });
    expect(fitWithin(10, 10)).toEqual({ width: 10, height: 10 });
  });

  it('scales the long side down to the limit and keeps the aspect ratio', () => {
    expect(fitWithin(3136, 1000)).toEqual({ width: 1568, height: 500 });
    expect(fitWithin(1000, 4000)).toEqual({ width: 392, height: 1568 });
    expect(fitWithin(4032, 3024)).toEqual({ width: 1568, height: 1176 });
  });

  it('never rounds a thin side to nothing', () => {
    expect(fitWithin(100_000, 10)).toEqual({ width: 1568, height: 1 });
  });
});

describe('imageInfo', () => {
  it('reads a PNG from its bytes', () => {
    expect(imageInfo(twoColorPng(40, 30, [255, 0, 0], [0, 0, 255]))).toEqual({ mediaType: 'image/png', width: 40, height: 30 });
  });

  it('reads GIF, JPEG and WebP headers', () => {
    const gif = Buffer.from([...Buffer.from('GIF89a'), 0x20, 0x01, 0x10, 0x00]);
    expect(imageInfo(gif)).toEqual({ mediaType: 'image/gif', width: 288, height: 16 });
    // SOI, an APP0 segment of 4 bytes, then SOF0 with height 0x0102 and width 0x0304.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x02, 0x03, 0x04, 0x03]);
    expect(imageInfo(jpeg)).toEqual({ mediaType: 'image/jpeg', width: 0x0304, height: 0x0102 });
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'ascii');
    vp8x.write('WEBPVP8X', 8, 'ascii');
    vp8x.writeUIntLE(799, 24, 3);
    vp8x.writeUIntLE(599, 27, 3);
    expect(imageInfo(vp8x)).toEqual({ mediaType: 'image/webp', width: 800, height: 600 });
  });

  it('is undefined for text, a truncated header, or a type the model does not read', () => {
    expect(imageInfo(Buffer.from('export const a = 1;\n'))).toBeUndefined();
    expect(imageInfo(twoColorPng(4, 4, [0, 0, 0], [0, 0, 0]).subarray(0, 12))).toBeUndefined();
    expect(imageInfo(Buffer.from('BM\x00\x00\x00\x00'))).toBeUndefined();
  });
});

describe('limits and refusals', () => {
  const image = { kind: 'image' as const, bytes: 1000 };
  it('refuses a ninth image', () => {
    const eight = Array.from({ length: MAX_IMAGES }, () => image);
    expect(overLimit(eight.slice(1), image)).toBeUndefined();
    expect(overLimit(eight, image)).toBe('A message holds up to 8 images.');
    expect(overLimit(eight, { kind: 'file', bytes: 10 })).toBeUndefined();
  });

  it('refuses what would take the message past 5 MB, files included', () => {
    expect(overLimit([{ kind: 'file', bytes: MAX_MESSAGE_BYTES - 1000 }], image)).toBeUndefined();
    expect(overLimit([{ kind: 'file', bytes: MAX_MESSAGE_BYTES - 999 }], image)).toBe(
      'This would bring the message to 5.0 MB; a message holds up to 5.0 MB of attachments.',
    );
    expect(overLimit([image], { kind: 'image', bytes: 6 * 1024 * 1024 })).toBe('This would bring the message to 6.0 MB; a message holds up to 5.0 MB of attachments.');
  });

  it('says a PDF is not read yet and any other binary is not an image or text', () => {
    expect(refusalOf('spec.pdf', 'application/pdf')).toBe('spec.pdf is a PDF, which Geno cannot read yet.');
    expect(refusalOf('SPEC.PDF', '')).toBe('SPEC.PDF is a PDF, which Geno cannot read yet.');
    expect(refusalOf('app.zip', 'application/zip')).toBe('app.zip is a binary file; attach an image or a text file.');
  });

  it('names a stored attachment by its hash and type', () => {
    expect(attachmentFileName(shot)).toBe(`${'a'.repeat(64)}.png`);
    expect(attachmentFileName({ ...shot, mediaType: 'image/jpeg' })).toBe(`${'a'.repeat(64)}.jpg`);
    expect(attachmentFileName(notes)).toBe(`${'b'.repeat(64)}.txt`);
  });
});

describe('replayMessages with attachments', () => {
  const user: TurnEvent = { kind: 'user', seq: 1, at, content: 'What is in these?', attachments: [notes, shot, outside, pasted] };

  it('sends the images first, then the prompt, then the files as @file items named as the model sees them', () => {
    expect(replayMessages([start, user], stored)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORbase64' } },
          { type: 'text', text: 'What is in these?' },
          {
            type: 'text',
            text: [
              'The user attached these from the editor, as they were when the message was sent:',
              '<context_item kind="file" path="docs/notes.md">\n1\tfirst\n2\tsecond\n</context_item>',
              '<context_item kind="file" path="/elsewhere/todo.txt">\n1\tx\n</context_item>',
              '<context_item kind="file" path="clip.txt">\nclip.txt is empty\n</context_item>',
            ].join('\n\n'),
          },
        ],
      },
    ]);
  });

  it('replays the same bytes each time, so the cached prefix holds', () => {
    const again: TurnEvent[] = [start, user, { kind: 'user', seq: 2, at, content: 'and now?' }];
    const first = JSON.stringify(replayMessages([start, user], stored)[0]);
    const second = replayMessages(again, stored)[0]!;
    expect(JSON.stringify({ ...second, content: (second.content as unknown[]).slice(0, 3) })).toBe(first);
  });

  it('notes an attachment whose bytes are gone instead of failing the request', () => {
    const [message] = replayMessages([start, { ...user, attachments: [shot, notes] }]);
    expect(message!.content).toEqual([
      { type: 'text', text: "[Geno] The image shot.png the user attached is no longer in the session's attachments folder." },
      { type: 'text', text: 'What is in these?' },
      {
        type: 'text',
        text: "The user attached these from the editor, as they were when the message was sent:\n\n<context_item kind=\"file\" path=\"docs/notes.md\">\n[Geno] docs/notes.md is no longer in the session's attachments folder.\n</context_item>",
      },
    ]);
  });

  it('sends a message of attachments alone without an empty text block', () => {
    const [message] = replayMessages([start, { kind: 'user', seq: 1, at, content: '', attachments: [shot] }], stored);
    expect(message!.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORbase64' } }]);
  });

  it('returns a read image inside its tool result, after the text', () => {
    const events: TurnEvent[] = [
      start,
      { kind: 'user', seq: 1, at, content: 'look at shot.png' },
      {
        kind: 'assistant',
        seq: 2,
        at,
        content: [{ type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'shot.png' }, caller: { type: 'direct' } }],
        stopReason: 'tool_use',
        usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        costUsd: 0,
        latencyMs: 1,
        model: 'qwen3.8-flash',
      },
      { kind: 'tool-result', seq: 3, at, toolUseId: 'tu1', name: 'read', status: 'ok', output: 'shot.png is a 4x2 PNG image.', images: [shot] },
    ];
    const request = buildRequest(session, events, [], 'system', stored);
    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: [
            { type: 'text', text: 'shot.png is a 4x2 PNG image.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORbase64' } },
          ],
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
  });
});

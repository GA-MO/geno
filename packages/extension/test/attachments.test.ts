import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_BYTES } from '@g-code/core/attachments';
import { admit, chooseEncoding, classify, KEEP_BYTES, needsRedraw, type Draft, type OutgoingAttachment } from '../src/chat/attachment-model.js';
import { imageTarget, setRoots, srcOf } from '../src/chat/images.js';
import { twoColorPng } from '../../core/test/png.js';

const image = (bytes: number): OutgoingAttachment => ({ kind: 'image', name: 'x.png', mediaType: 'image/png', data: '', bytes, width: 10, height: 10, thumb: '' });

describe('classify', () => {
  it('knows an image by its bytes, text by its decoding, and refuses PDFs and other binaries', () => {
    expect(classify('flag', '', twoColorPng(4, 2, [255, 0, 0], [0, 0, 255]))).toEqual({ kind: 'image', info: { mediaType: 'image/png', width: 4, height: 2 } });
    expect(classify('a.ts', 'text/plain', new TextEncoder().encode('export const a = 1;\n'))).toEqual({ kind: 'text', text: 'export const a = 1;\n' });
    expect(classify('spec.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.7\n\0\0'))).toEqual({ kind: 'refused', reason: 'spec.pdf is a PDF, which Geno cannot read yet.' });
    expect(classify('app.bin', '', Uint8Array.from([0xc3, 0x28, 0x41]))).toEqual({ kind: 'refused', reason: 'app.bin is a binary file; attach an image or a text file.' });
  });
});

describe('downscaling choices', () => {
  it('redraws an image past 1568 pixels or past 1 MB, and keeps a small one as it is', () => {
    expect(needsRedraw({ mediaType: 'image/png', width: 1568, height: 1000 }, 200_000)).toBe(false);
    expect(needsRedraw({ mediaType: 'image/png', width: 1569, height: 1000 }, 200_000)).toBe(true);
    expect(needsRedraw({ mediaType: 'image/png', width: 800, height: 600 }, KEEP_BYTES + 1)).toBe(true);
  });

  it('keeps a photo JPEG, a screenshot PNG, and turns a large PNG photo into JPEG', () => {
    expect(chooseEncoding('image/jpeg', 3_000_000, 400_000)).toBe('image/jpeg');
    expect(chooseEncoding('image/png', 300_000, 200_000)).toBe('image/png');
    expect(chooseEncoding('image/png', 2_000_000, 1_200_000)).toBe('image/png');
    expect(chooseEncoding('image/png', 2_000_000, 500_000)).toBe('image/jpeg');
  });
});

describe('admit', () => {
  it('makes a draft ready while it fits, and rejects the one that goes over with the reason', () => {
    const drafts: Draft[] = [
      { id: 'a', name: 'a.png', state: 'ready', attachment: image(MAX_MESSAGE_BYTES - 10) },
      { id: 'b', name: 'b.png', state: 'reading' },
      { id: 'c', name: 'c.png', state: 'reading' },
    ];
    const once = admit(drafts, 'b', image(10));
    expect(once[1]).toMatchObject({ id: 'b', state: 'ready' });
    expect(admit(once, 'c', image(1))[2]).toEqual({
      id: 'c',
      name: 'c.png',
      state: 'rejected',
      reason: 'This would bring the message to 5.0 MB; a message holds up to 5.0 MB of attachments.',
    });
  });
});

describe('images in the transcript', () => {
  setRoots([{ path: '/work/ws', uri: 'https://file+.vscode-resource.vscode-cdn.net/work/ws' }]);

  it('serves a workspace file through the webview address of its folder', () => {
    expect(srcOf('/work/ws/docs/my shot.png')).toBe('https://file+.vscode-resource.vscode-cdn.net/work/ws/docs/my%20shot.png');
    expect(srcOf('/work/ws/../secret.png')).toBeUndefined();
    expect(srcOf('/work/wsx/a.png')).toBeUndefined();
  });

  it('loads a relative or absolute workspace image, and never a remote or outside one', () => {
    expect(imageTarget('docs/shot.png')).toEqual({ kind: 'local', path: '/work/ws/docs/shot.png', src: 'https://file+.vscode-resource.vscode-cdn.net/work/ws/docs/shot.png' });
    expect(imageTarget('file:///work/ws/a.png')).toMatchObject({ kind: 'local', path: '/work/ws/a.png' });
    expect(imageTarget('https://tracker.example.com/pixel.png')).toEqual({ kind: 'remote', href: 'https://tracker.example.com/pixel.png' });
    expect(imageTarget('//cdn.example.com/a.png')).toEqual({ kind: 'remote', href: '//cdn.example.com/a.png' });
    expect(imageTarget('data:image/png;base64,AAAA')).toMatchObject({ kind: 'remote' });
    expect(imageTarget('../outside.png')).toEqual({ kind: 'outside', href: '../outside.png' });
    expect(imageTarget('/etc/a.png')).toEqual({ kind: 'outside', href: '/etc/a.png' });
  });
});

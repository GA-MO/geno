import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DINO_DIST, DINO_FILES } from '../src/dino.js';

describe('the dinosaur', () => {
  it('is green and white with one dark eye: no spots, no blush', async () => {
    const svg = await readFile(path.resolve('packages/extension', DINO_FILES.avatar), 'utf8');
    const fills = new Set([...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map(([, fill]) => fill));
    expect([...fills].sort()).toEqual(['#14231f', '#5fc79a', '#ffffff']);
    expect([...svg.matchAll(/fill="#14231f"/g)]).toHaveLength(1);
  });

  it('is what package.json shows: the activity bar and extension icons are the files the build copies', async () => {
    const manifest = JSON.parse(await readFile(path.resolve('packages/extension/package.json'), 'utf8'));
    expect(manifest.icon).toBe(DINO_DIST.icon);
    expect(manifest.contributes.viewsContainers.activitybar[0].icon).toBe(DINO_DIST.mono);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { llamaServerArgs } from '../src/tab/server.js';

describe('llamaServerArgs', () => {
  it('starts llama-server with the flags scripts/tab-server.sh uses', () => {
    const script = readFileSync(path.resolve('scripts/tab-server.sh'), 'utf8');
    const scriptFlags = [...script.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1]);
    const args = llamaServerArgs('/models/qwen2.5-coder-1.5b-q8_0.gguf', 8099);

    expect(args.filter((arg) => arg.startsWith('--'))).toEqual(scriptFlags);
    expect(args.join(' ')).toBe(
      '--model /models/qwen2.5-coder-1.5b-q8_0.gguf --alias qwen2.5-coder-1.5b-q8_0 --host 127.0.0.1 --port 8099 ' +
        '--n-gpu-layers 99 --flash-attn on --ctx-size 4096 --parallel 1 --cache-reuse 256 --no-webui',
    );
  });
});

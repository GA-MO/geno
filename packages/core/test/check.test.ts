import { describe, expect, it } from 'vitest';
import { incrementalTsc } from '../src/check.js';

const INFO = '/home/u/.g-code/check-cache/abc/tsbuildinfo';

describe('incrementalTsc', () => {
  it('keeps the build info of a plain tsc --noEmit outside the workspace', () => {
    expect(incrementalTsc('npx tsc --noEmit', INFO, true)).toBe(`./node_modules/.bin/tsc --noEmit --incremental --tsBuildInfoFile '${INFO}'`);
    expect(incrementalTsc('npx tsc --noEmit', INFO, false)).toBe(`npx tsc --noEmit --incremental --tsBuildInfoFile '${INFO}'`);
    expect(incrementalTsc('tsc --noEmit -p tsconfig.app.json', INFO, true)).toBe(`tsc --noEmit -p tsconfig.app.json --incremental --tsBuildInfoFile '${INFO}'`);
  });

  it('quotes a build info path with spaces or quotes', () => {
    expect(incrementalTsc('tsc --noEmit', "/Users/O'Brien/My Home/tsbuildinfo", false)).toBe(`tsc --noEmit --incremental --tsBuildInfoFile '/Users/O'\\''Brien/My Home/tsbuildinfo'`);
  });

  it('leaves every other command as it is', () => {
    for (const command of [
      'pnpm typecheck',
      'npx tsc',
      'tsc -b --noEmit',
      'tsc --noEmit --watch',
      'tsc --noEmit --incremental false',
      'tsc --noEmit --tsBuildInfoFile=x',
      'npx tsc --noEmit && npx vitest run',
      'npx tsc --noEmit | tail',
      'npx tsc --noEmit; rm -rf x',
      'npx tsc --noEmit $(echo)',
      'npx -y tsc --noEmit',
      'tsc --noEmit "a b"',
    ]) {
      expect(incrementalTsc(command, INFO, true), command).toBeUndefined();
    }
  });
});

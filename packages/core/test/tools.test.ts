import { describe, expect, it } from 'vitest';
import { changesDirectory, leadingSleep, TOOL_DEFINITIONS, TOOL_NAMES, TOOL_SPECS } from '../src/index.js';

describe('TOOL_DEFINITIONS', () => {
  it('lists every tool once, sorted by name, under its own key', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toEqual([...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) expect(TOOL_SPECS[name].name).toBe(name);
  });

  it('cannot be changed at runtime, so the cached prefix stays byte-stable', () => {
    const before = JSON.stringify(TOOL_DEFINITIONS);
    expect(() => (TOOL_DEFINITIONS as unknown[]).push({})).toThrow();
    expect(() => {
      (TOOL_DEFINITIONS[0] as { description: string }).description = 'changed';
    }).toThrow();
    expect(JSON.stringify(TOOL_DEFINITIONS)).toBe(before);
  });
});

describe('leadingSleep', () => {
  it.each([
    ['sleep 45; cat x', { seconds: 45, rest: 'cat x' }],
    ['  sleep 2 && npm test', { seconds: 2, rest: 'npm test' }],
    ['sleep 1m\ncurl -s localhost:3000', { seconds: 60, rest: 'curl -s localhost:3000' }],
    ['sleep 2.5s ;  tail log', { seconds: 2.5, rest: 'tail log' }],
  ])('%j waits first', (command, found) => {
    expect(leadingSleep(command)).toEqual(found);
  });

  it.each(['sleep 1; cat x', 'sleep 1.9 && cat x', 'sleep 30', 'sleep 45 & cat x', 'cat x; sleep 45; cat y', 'sleep $DELAY; cat x', 'sleeper 45; cat x'])(
    '%j is not a leading wait of 2 s or more before other work',
    (command) => {
      expect(leadingSleep(command)).toBeUndefined();
    },
  );
});

describe('changesDirectory', () => {
  it.each(['cd sub && pwd', 'pwd; cd /tmp', 'pushd sub && make', 'if true; then cd sub; fi'])('%j changes directory', (command) => {
    expect(changesDirectory(command)).toBe(true);
  });

  it.each(['pwd', "echo 'cd sub'", 'make -C sub', 'abcd sub'])('%j does not', (command) => {
    expect(changesDirectory(command)).toBe(false);
  });
});

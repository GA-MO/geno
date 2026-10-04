import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS, TOOL_NAMES, TOOL_SPECS } from '../src/index.js';

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

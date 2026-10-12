import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { autoStep, cueOf, dwell } from '../src/components/motion.js';
import { loadSite, siteOptions } from '../src/scenario/site.js';
import { branchesAt, choose, storyBeats, storyStart, type Beat, type StoryState } from '../src/scenario/story.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = loadSite(siteOptions(DOCS));
const scenario = site.scenarios['ask-mode-bash-approval']!;

/** Presses play from the first beat and follows it until it waits or stops, as the timer would. */
function playFrom(state: StoryState): { readonly visited: number[]; readonly halt: 'wait' | 'stop'; readonly at: number } {
  const beats = storyBeats(scenario, state.choices);
  const visited = [state.at];
  let at = state.at;
  for (;;) {
    const next = autoStep(beats, at);
    if (next.kind !== 'advance') return { visited, halt: next.kind, at };
    at += 1;
    visited.push(at);
  }
}

describe('play', () => {
  test('walks beat by beat, waits at the fork for the reader, then runs to the last beat and stops', () => {
    const start = storyStart(scenario);
    const beats = storyBeats(scenario, start.choices);
    const fork = beats.findIndex((beat) => beat.flow.kind === 'fork');
    expect(fork).toBeGreaterThan(0);

    const first = playFrom(start);
    expect(first).toEqual({ visited: [...Array(fork + 1).keys()], halt: 'wait', at: fork });

    const other = branchesAt(scenario, start.choices, beats[fork]!.last).find((branch) => !branch.chosen)!;
    const picked = choose(scenario, { ...start, at: fork }, other.fork, other.option.id);
    const rest = playFrom(picked);
    expect(rest.halt).toBe('stop');
    expect(rest.at).toBe(storyBeats(scenario, picked.choices).length - 1);
  });

  test('gives a longer beat more time to read, within 2.5 to 10 seconds', () => {
    const beat = storyBeats(scenario, scenario.defaults)[0]!;
    const sized = (text: string): Beat => ({ ...beat, head: { ...beat.head, title: 'ก', text } });
    expect(dwell(sized(''))).toBe(2_500);
    expect(dwell(sized('ก'.repeat(80)))).toBeGreaterThan(dwell(sized('ก'.repeat(40))));
    expect(dwell(sized('ก'.repeat(2_000)))).toBe(10_000);
  });
});

describe('motion cues', () => {
  const start = storyStart(scenario);
  const beats = storyBeats(scenario, start.choices);
  const fork = beats.findIndex((beat) => beat.flow.kind === 'fork');

  test('a render that changes nothing (a view switch, a resize) plays nothing', () => {
    expect(cueOf(start, { ...start })).toBeUndefined();
  });

  test('a step plays the beat and no fork; a pick plays the fork it was made at', () => {
    expect(cueOf(start, { ...start, at: 1 })).toEqual({ forks: [] });
    const other = branchesAt(scenario, start.choices, beats[fork]!.last).find((branch) => !branch.chosen)!;
    expect(cueOf({ ...start, at: fork }, choose(scenario, { ...start, at: fork }, other.fork, other.option.id))).toEqual({ forks: [other.fork] });
  });
});

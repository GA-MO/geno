import { describe, expect, it } from 'vitest';
import { renderLoadedContext, SKILL_DESCRIPTION_CHARS, SKILL_LISTING_CHARS, skillListing } from '../src/index.js';

const entry = (name: string, length: number) => ({ name, description: 'x'.repeat(length) });

/** The entry lines as rendered, which is what the budget bounds. */
const listedChars = (listing: ReturnType<typeof skillListing>): number => {
  const text = renderLoadedContext({ instructions: [], rules: [], skillListing: listing })!;
  return text.slice(text.indexOf('\n\n- ') + 2).length;
};

describe('skillListing', () => {
  it('keeps the first line of each description, cut to its cap', () => {
    const listing = skillListing([
      { name: 'deploy', description: 'Ship the app.\nThen tell the team in #releases.' },
      { name: 'long', description: 'y'.repeat(SKILL_DESCRIPTION_CHARS + 40) },
    ]);
    expect(listing).toEqual({
      skills: [
        { name: 'deploy', description: 'Ship the app.' },
        { name: 'long', description: `${'y'.repeat(SKILL_DESCRIPTION_CHARS - 1)}…` },
      ],
      unlisted: 0,
    });
  });

  it('lists everything whole when it fits', () => {
    const skills = [entry('a', 100), entry('b', 10)];
    expect(skillListing(skills, 200).skills).toEqual(skills);
  });

  it('cuts the longest descriptions first when the whole list does not fit, and stays within the budget', () => {
    const listing = skillListing([entry('a', 200), entry('b', 20), entry('c', 200)], 300);
    const [a, b, c] = listing.skills.map((s) => s.description.length);
    expect(b).toBe(20);
    expect(a).toBe(c);
    expect(a).toBeLessThan(200);
    expect(a).toBeGreaterThan(100);
    expect(listedChars(listing)).toBeLessThanOrEqual(300);
  });

  it('lists names alone when descriptions would be cut too short to help', () => {
    const listing = skillListing([entry('one', 200), entry('two', 200)], 30);
    expect(listing).toEqual({ skills: [{ name: 'one', description: '' }, { name: 'two', description: '' }], unlisted: 0 });
  });

  it('counts the skills whose names no longer fit', () => {
    const listing = skillListing([entry('alpha', 5), entry('beta', 5), entry('gamma', 5)], 16);
    expect(listing).toEqual({ skills: [{ name: 'alpha', description: '' }, { name: 'beta', description: '' }], unlisted: 1 });
  });

  it('bounds the listing by default at Claude Code-sized budget', () => {
    const many = Array.from({ length: 120 }, (_, i) => entry(`skill-${i}`, 300));
    const listing = skillListing(many);
    expect(listing.unlisted).toBe(0);
    expect(listedChars(listing)).toBeLessThanOrEqual(SKILL_LISTING_CHARS);
  });
});

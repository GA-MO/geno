// Page data and markdown keep site paths such as `/start/glossary/`. The deploy's base (`/geno` on GitHub Pages, empty
// in dev) goes on where a link is rendered.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export const withBase = (sitePath: string): string => `${BASE}${sitePath}`;

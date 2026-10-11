import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite, siteOptions } from '../src/scenario/site.js';

const site = loadSite(siteOptions(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
const errors = site.problems.filter((problem) => problem.level === 'error');
const warnings = site.problems.filter((problem) => problem.level === 'warning');

for (const problem of [...warnings, ...errors]) console.log(`${problem.level === 'error' ? 'error' : 'warn '}  ${problem.file}  ${problem.path}  ${problem.message}`);
const covered = Object.values(site.links).filter((link) => link.href !== undefined).length;
console.log(
  `docs:check: ${Object.keys(site.scenarios).length} scenario page(s), ${covered}/${site.catalog.scenarios.length} catalog scenarios covered, ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exitCode = errors.length === 0 ? 0 : 1;

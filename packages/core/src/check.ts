/** Flags that change what a `tsc` run does beyond checking, or already say where its build info goes. */
const KEEPS_ITS_OWN_BUILD = new Set(['-b', '--build', '-w', '--watch', '-i', '--incremental', '--tsBuildInfoFile', '--composite']);

const PLAIN_WORDS = /^[\w./=:@+,-]+$/;

const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The same type check with its build info kept in `buildInfoFile`, so a later run checks only what changed and the
 * workspace gets no `.tsbuildinfo`; undefined when `command` is anything but one plain `tsc --noEmit` run. `npx tsc`
 * runs the workspace's own tsc directly when it has one (`localTsc`), the binary npx would pick, without npx's start.
 */
export function incrementalTsc(command: string, buildInfoFile: string, localTsc: boolean): string | undefined {
  const words = command.trim().split(/\s+/);
  if (!words.every((word) => PLAIN_WORDS.test(word))) return undefined;
  const npx = words[0] === 'npx';
  const [tsc, ...args] = npx ? words.slice(1) : words;
  if (tsc !== 'tsc' || !args.includes('--noEmit')) return undefined;
  if (args.some((arg) => KEEPS_ITS_OWN_BUILD.has(arg.split('=')[0]!))) return undefined;
  const bin = npx ? (localTsc ? './node_modules/.bin/tsc' : 'npx tsc') : 'tsc';
  return [bin, ...args, '--incremental', '--tsBuildInfoFile', quoted(buildInfoFile)].join(' ');
}

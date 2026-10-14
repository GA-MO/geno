// What Geno's own shell rules say about bash command lines, for the checks to judge a run by instead of regexes of their own.
// usage: echo '["cat a.ts", "echo x > b.txt"]' | tsx scripts/real-usecases/shell-facts.ts <workspace>
// Prints one entry per command, in order: { fileSteps, writeSteps, inPlaceEdits, refusal }.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileStepRefusal, fileStepsOf, stepsOf, writeStepsOf, type FileStep, type WriteStep } from '../../packages/core/src/shell-intent.js';

type ShellFacts = {
  /** The pipelines read, list, glob or grep does, which Geno refuses. */
  readonly fileSteps: readonly FileStep[];
  /** The pipelines that only write literal text into workspace files, which Geno refuses as edit's job. */
  readonly writeSteps: readonly WriteStep[];
  /** The workspace files a sed -i or perl -i in the line changes in place, which Geno runs. */
  readonly inPlaceEdits: readonly string[];
  /** The text Geno refuses the line with before running any of it, if it does. */
  readonly refusal: string | undefined;
};

const IN_PLACE: Readonly<Record<string, (arg: string) => boolean>> = {
  sed: (arg) => /^(?:-[a-zA-Z]*i|--in-place)/.test(arg),
  perl: (arg) => /^-[a-zA-Z]*i/.test(arg),
};

/** The files a sed -i or perl -i edits: its last word, when that word names a place inside the workspace. */
function inPlaceEdits(command: string, workspace: string): string[] {
  return (stepsOf(command) ?? []).flatMap((step) =>
    step.commands.flatMap(({ program, args }) => {
      const file = args.at(-1);
      if (IN_PLACE[program] === undefined || !args.some(IN_PLACE[program]) || file === undefined || file.startsWith('-') || /^[$~]/.test(file)) return [];
      const resolved = path.resolve(workspace, file);
      return resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`) ? [file] : [];
    }),
  );
}

const shellFacts = (command: string, workspace: string): ShellFacts => ({
  fileSteps: fileStepsOf(command),
  writeSteps: writeStepsOf(command, workspace),
  inPlaceEdits: inPlaceEdits(command, workspace),
  refusal: fileStepRefusal(command, workspace),
});

const workspace = process.argv[2];
if (workspace === undefined) throw new Error('usage: tsx scripts/real-usecases/shell-facts.ts <workspace> < commands.json');
const commands = JSON.parse(readFileSync(0, 'utf8')) as string[];
process.stdout.write(JSON.stringify(commands.map((command) => shellFacts(command, path.resolve(workspace)))));

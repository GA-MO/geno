import { createInterface } from 'node:readline/promises';

type Input = NodeJS.ReadableStream & { readonly isTTY?: boolean | undefined };

/**
 * The CLI's yes or no on a card. With no terminal there is nobody to answer, so the card is refused, and stderr says so:
 * a run that refused every card in silence looked like one that never asked (ISSUES.md G-10).
 */
export const terminalConfirm =
  (input: Input, output: NodeJS.WritableStream) =>
  async (question: string): Promise<boolean> => {
    if (input.isTTY !== true) {
      output.write(`${question} There is no terminal to answer, so it was refused.\n`);
      return false;
    }
    const prompt = createInterface({ input, output });
    try {
      return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim());
    } finally {
      prompt.close();
    }
  };

import { z } from 'zod';
import { MARK_CHAPTER_TOOL, markedText, newChapterOf, parseChapterMark, type Chapter } from '@g-code/core';
import { executor, ToolError, type Executor } from './context.js';

/**
 * mark_chapter. It changes nothing: the result the call logs carries the chapter, which the panel draws and a replay
 * folds. `chapters` reads the session's chapters from its log on disk, so a chapter the user marked beside the running
 * turn counts as the current one.
 */
export function chapterExecutor(chapters: () => Promise<readonly Chapter[]>): Executor {
  return executor({
    input: z.unknown().transform((raw, ctx) => {
      const parsed = parseChapterMark(raw);
      if (parsed.ok) return parsed.value;
      ctx.addIssue({ code: 'custom', message: parsed.problem });
      return z.NEVER;
    }),
    describe: ({ title }) => `${MARK_CHAPTER_TOOL} ${title}`,
    run: async (mark) => {
      const chapter = newChapterOf(mark, await chapters());
      if (!chapter.ok) throw new ToolError(chapter.problem);
      return { text: markedText(chapter.value), chapter: chapter.value };
    },
  });
}

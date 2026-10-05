import { z } from 'zod';
import { parseShowWidget, WIDGET_TOOL } from '@g-code/core';
import { storeWidget } from '../attachments.js';
import { executor, type Executor } from './context.js';

/** The input, parsed by core's rules, so the model reads the same message whichever rule it broke. */
const widgetInput = z.unknown().transform((raw, ctx) => {
  const parsed = parseShowWidget(raw);
  if (parsed.ok) return parsed.value;
  ctx.addIssue({ code: 'custom', message: parsed.problem });
  return z.NEVER;
});

/** Stores the widget in the session's attachments; the editor draws it from the result the call logs. */
export const showWidget: Executor = executor({
  input: widgetInput,
  describe: ({ title }) => `${WIDGET_TOOL} ${title}`,
  async run({ title, html }, ctx) {
    const widget = await storeWidget(ctx.attachmentsDir, html, title);
    return { text: `Shown to the user in the chat: "${title}".`, widget };
  },
});

// The two model readers of a run: whether its last words handed work back to the user, and which of two blind
// transcripts served the user better. Both call the Messages API with the campaign's key.
import { campaignEnv } from '../real-usecases/env.mjs';

const env = campaignEnv();

async function ask(model, system, user, maxTokens = 2000) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens + 4000, system, messages: [{ role: 'user', content: user }] }),
    });
    if (res.ok) {
      const body = await res.json();
      const text = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      if (json !== undefined) return JSON.parse(json);
      if (attempt >= 4) throw new Error(`no JSON in the answer (stop ${body.stop_reason}): ${text.slice(0, 200)}`);
      continue;
    }
    if (attempt >= 4 || ![429, 500, 502, 503, 529].includes(res.status)) throw new Error(`${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

const HANDBACK_SYSTEM = `You read the last message a coding agent wrote before it stopped and waited for the user. Classify how it ended.
- "done": it reports finished work, or answers a question the user asked, and needs nothing from the user to go on.
- "question": it asks the user to decide or confirm something before it goes on.
- "offer": it offers more work ("if you want I can…", "tell me if…", "shall I…", "ถ้าอยากให้… บอกได้").
- "handoff": it tells the user to do a step themselves (run a command, check something in the browser, grant a permission) that the agent could have tried itself.
- "unfinished": it stopped in the middle of the work without saying so, or says it ran out of turns or budget.
A finished report that also mentions an optional idea in passing is still "offer" if it ends by inviting the user to ask for it.
"necessary" is true only for a question no reasonable default could settle (a real product or taste choice with no hint in the request), or a handoff of something the agent truly cannot do (the user's own login, hardware).
Answer with JSON only: {"kind": "...", "necessary": true|false, "why": "<one short sentence>"}`;

/** How a run's segment ended: done, or handed back as a question, offer, handoff or unfinished. */
export const classifyEnd = (task, text, stoppedBy) =>
  ask('claude-sonnet-5-5', HANDBACK_SYSTEM, `The user's request was:\n${task}\n\n${stoppedBy ? `The harness stopped the agent: ${stoppedBy}\n\n` : ''}The agent's last message:\n<<<\n${text.slice(-4000)}\n>>>`, 400);

const JUDGE_SYSTEM = `You compare two coding agents that got the same request from the same user, in the same repository, with the same model. The user is a senior frontend engineer who hands work off so they do not have to do it: every time they must decide, re-check, or tell the agent to go on, the hand-off failed.
Judge which transcript served the user better, in this order:
1. Did the work the request asks for get done, fully and correctly, as far as the transcript and the change summary show?
2. Did the agent keep going on its own judgement instead of stopping to ask, offer, or hand steps back? A question is fine only if no reasonable default exists.
3. Did it check its own result on the real thing (ran it, opened the page, looked at the screen) before it said it was done?
4. Is the final report honest and short, with no claim the transcript does not back?
Cost and speed matter only to break a tie. Ignore style differences in tool names. Say "tie" only when neither is clearly better.
Answer with JSON only: {"winner": "A" | "B" | "tie", "why": "<two sentences>"}`;

/** One blind comparison; the caller runs both orders and keeps the verdict only when they agree. */
export const judgePair = (task, a, b) =>
  ask('claude-opus-5-5', JUDGE_SYSTEM, `The user's request:\n${task}\n\n=== TRANSCRIPT A ===\n${a}\n\n=== TRANSCRIPT B ===\n${b}`, 600);

# Story layer for scenario tours

A tour has two layers. The fine steps (`lane`, `do`, `ref`, `emits`, forks, fragments) stay the truth that
`docs:check` verifies against the code. The story layer groups those steps into 8 to 15 beats that a newcomer reads
first. The fine steps of a beat open on demand under "ดูขั้นในโค้ด" (show internals).

## Data shape

A beat starts at a `beat:` header. The header sits on an acting step or on a `use:` entry:

```yaml
steps:
  - id: wants
    lane: model
    beat:
      title: Model ขอรัน `pnpm add zod`          # Thai with English terms, at most 60 characters
      text: >-                                  # Thai, 1 to 3 sentences, no function names
        โมเดลตอบกลับมาว่ายังไม่จบ มันอยากรันคำสั่ง `pnpm add zod` บนเครื่องของคุณก่อน
      from: model                               # required: who acts
      to: engine                                # required: who receives
      sees: { kind: step, label: pnpm add zod, status: running }   # optional, see "What the reader sees"
      ask: Which button?                        # required when the beat ends at a fork: the diamond's label
      end: Denied by you                        # optional: the end node's label when a walk ends in this beat
    do: ...
  - id: logged          # no header: belongs to the beat above
    lane: loop
    ...
  - use: tool-call-opens
    beat: { title: Geno shows the command in your chat, text: ... }
```

A step without a header belongs to the most recent header on the walk that reaches it. Beats are derived along each
walk, so a step after a rejoin (`then:`) joins whichever arm's beat came before it, unless it has its own header.
Forks, fragments, `via`, the hash and every existing check need no new logic.

The compiled `Step` gains two fields: `actor` (from its lane) and `beat?` (the parsed header). `Scenario` gains
`story: boolean`. `story.ts` derives the rest at read time:

- `beatsOf(scenario, path)` splits a walk at headers. Each `Beat` holds its header step id, its steps, `from`, `to`,
  `who` and the `flow` of its last step (`next`, `fork`, `end` or `leave`).
- `branchesAt(scenario, choices, fork)` gives, per option, the beat it opens and the ending its walk reaches. The
  diagrams draw these as the labeled branches of a decision diamond.

## Actors

Five story actors come from `lanes.yaml`. Each lane has an `actor:` field. Pages never author actors per step.

Every beat header names its arrow with `from` and `to`; `docs:check` fails a beat without either. The lanes of a beat's
steps do not decide it, because a beat often spans several lanes. Read the beat and pick:

- the model's requests and answers: `model` → `engine`;
- Geno's decisions and refusals: `engine` → `model`, or `engine` → `panel` when the chat shows them;
- a command or tool on your machine: `engine` → `machine`, and its result back: `machine` → `engine`;
- what you see: `panel` → `you`; your clicks and keys: `you` → `panel`;
- a self-action, such as Geno checking a rule: `from` equals `to`.

| actor | name | lanes |
| --- | --- | --- |
| `you` | คุณ | user |
| `panel` | Geno panel | panel, editor |
| `engine` | Geno engine | server, loop, policy |
| `model` | AI model | model, child |
| `machine` | เครื่องของคุณ | tool, external |

The who-acts badge comes from `from`: `you` is คุณ, `model` is AI, and anything else is Geno.

## What the reader sees

`sees` is either plain text or one typed mock, or a list of them. Each mock renders as a small, faithful copy of the
real UI. Mock text quotes the UI exactly, so it stays in the product's English.

| kind | props |
| --- | --- |
| `permission` | `face?` (default `command`), `command`, `host?`, `server?`, `tool?`, `scope?`, `reason?`, `rule?`, `options?` (default: the face's buttons), `chosen?`, `note?` |
| `question` | `question`, `options`, `chosen?` |
| `notice` | `text`, `detail?`, `actions?`, `tone?` (`info`, `warning`, `error`) |
| `step` | `label`, `status` (`running`, `done`, `failed`, `denied`), `note?`, `output?` |
| `message` | `from` (`you`, `geno`), `text`, `streaming?`, `footer?` |
| `toast` | `text`, `actions?` |
| `composer` | `state` (`idle`, `working`), `text?`, `header?` |
| `task` | `title`, `status` (`running`, `needs-input`, `done`, `failed`), `detail?`, `actions?` |
| `payload` | real wire data from a recorded run, see below |

### `permission`: the card's face

`face` picks the card the panel draws, with its title and the buttons the engine offers. `src/scenario/faces.ts` holds
them, and a test checks each against the extension and engine source.

| face | title | buttons |
| --- | --- | --- |
| `command` | Run this command? | Allow, Deny, Always allow in this workspace, No, and tell the agent… |
| `edit` | Change this file? (external agents only) | as `command` |
| `read` | Read outside the workspace? | Allow, Allow this directory for the session, Deny, No, and tell the agent… |
| `fetch` | Fetch from `host`? | as `command` |
| `browse` | Open a page on `host`? | Allow, Deny, No, and tell the agent… |
| `mcp` | Use `server` tool `tool`? | Allow, Allow this tool for the session, Deny, Always allow in this workspace, No, and tell the agent… |
| `memory` | Remember this? and the `scope` line | Remember, Don't remember |
| `workflow` | Run this workflow? | Run, Don't run |
| `server`, `server-connect` | Allow this server to run? / to connect? | Allow, Turn off |

### `payload`: real wire data

A payload mock shows what Geno sends the model, what the model returns, what goes back as a tool result, or what Geno
logs. Its JSON comes from a recorded run under `docs/results/real-usecases/runs/<case>/<n>/`, read at build time:

```yaml
sees:
  - kind: payload
    source: docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=9
    select: messages[-1]               # optional JSON path into the record; default: the whole record
    highlight: [content[0].tool_use_id] # optional paths, relative to the selection
    collapse: [content[0].content]      # optional paths shown folded
  - kind: payload
    source: docs/results/real-usecases/runs/A06-read-not-cat/1/session.jsonl#seq=9
    select: content
```

- `requests.jsonl#seq=N` is the request with that `seq`, expanded (`$prefix`, `$same`) the way the runs README says.
- `session.jsonl#seq=N` is the session event with that `seq`.
- `wire.jsonl#line=N` is line N, counting from 1: a request body, expanded the same way, or a response stream as a
  list of `{ event, data }`, one per SSE event. Any file takes `#line=N`.
- A `.jsonl.gz` file reads the same as its `.jsonl`.
- Paths use dots and brackets. `[-1]` counts from the end.
- `quote: <text>` marks that text in the card. A long string that holds it keeps the stretch around it, not its start,
  so a card can point at one sentence of a 10,000-character system prompt and still show the whole prompt block.

A card shows one whole unit, and `resolve` in `src/scenario/payload.ts` decides which: a request, a response, a
stream or one of its events, a request's `messages`, `tools` or `system`, one message, one tool, the `content` of a
message or one of its blocks, or one session log event. A `select` that stops inside a unit, such as
`content[-1].input`, an event's `output`, or `usage`, renders the whole unit with the part highlighted, and
`docs:check` fails it with the select and highlight to write instead. The rule covers every route: a beat's `sees`,
a page's `payloads:`, `<Payload>`, and the static story list, which renders the same views.

The label comes from the unit, never from the page:

| unit | label |
| --- | --- |
| request | Request ที่ส่งให้ model |
| response, model-output (blocks of a response or an `assistant` event) | คำตอบของ model |
| tool-result (`tool_result` blocks, or a message of only those) | ผลของ tool (block tool_result) |
| request-content (other blocks of a request message) | เนื้อหาข้อความใน request |
| message, messages, tools, tool, system | ข้อความหนึ่งใน request, messages ใน request, tool ทั้งหมดใน request, นิยาม tool, System prompt |
| stream, stream-event | Stream ที่ model ส่งกลับ, Event หนึ่งใน stream ของ model |
| log-event | บันทึกใน session log, plus a Thai line on what that kind of event records |

- A card that shows a message, its `content`, or one of its blocks gets a chip row above the JSON listing the
  message's blocks in order (`thinking · text · tool_use edit · tool_use edit`). A chip scrolls the JSON to its
  block; a dashed chip is a block of the same message that the card does not show.
- A tool result card, and a logged `tool-result` event, names the call it answers ("ตอบ `tool_use edit`
  (toolu_…)") when the matching `tool_use` is in the same record or the same file.
- To show what the model got back from a tool, point at the `tool_result` block in the next request
  (`requests.jsonl` or `wire.jsonl`, `select: messages[-1].content[i]`), not at the session log's `output`.
- The first card on a page that shows a `tool_use` block carries a Thai line on reading one: `name`, `input`, `id`.
  In a story it is the first beat with one; on other pages, CSS hides it on every later `Payload`.

`docs:check` fails when the file, the `seq` or line, the `select` path, a `highlight`/`collapse` path, or a `quote`
does not resolve. The build trims the excerpt: strings over 240 characters keep 160 and show "… 10,905 ตัวอักษร", and
arrays over 6 items show "… อีก 6 รายการ". Several payloads in one `sees` render as tabs, every panel in the HTML. The
caption names the run and model ("A06 read-not-cat, qwen3.8-flash"), links the source file, and says where the bytes
come from: recorded bytes (`wire.jsonl`), a request rebuilt from the session log (`requests.jsonl`) or a logged event
(a session log), plus the engine commit when `runs/index.json` records it.

`pnpm --filter @g-code/docs cards <url>` reads every card a running dev or preview server renders and fails on a card
whose JSON is not a whole unit of its kind, a `tool_use` or `tool_result` block missing its ids, a tool result with no
chip row or answered call, a log event not labelled as one, or a page whose payloads render no card.

A page that is not a tour lists its payloads by name in its frontmatter and shows them with the `Payload` component.
`docs:check` reads them on every page:

```mdx
---
title: …
payloads:
  sent: { source: "docs/results/real-usecases/runs/A06-read-not-cat/fix-a1/wire.jsonl#line=3", select: messages }
---
import Payload from '../../../components/Payload.astro';

<Payload of={frontmatter.payloads.sent} />
```

## Checks

On a page with any beat header:

- the first step (or `use:` entry) carries a header, so no step comes before the first beat;
- every fork arm starts with a header;
- every walk has 2 or more beats;
- every title is at most 60 characters (graphemes, so Thai marks do not count twice);
- a beat whose last step forks has `ask`;
- every mock validates, and every `payload` source resolves;
- fragments carry no headers, because many pages share them.

A page with no header keeps working. Its tour shows a "story coming" state and the full step list.

## Rendering

`Story.tsx` replaces the old tour island. It has two views over the same beats, Sequence (default) and Swim lanes,
with the choice kept in `localStorage`. Both draw a fork as a diamond whose branches end in end nodes. In Swim lanes
the diamond fans out to a column of its own: one chip per option, in option order, each non-chosen chip naming its
ending, and the walk goes on from the chosen chip. Lanes stay compact (76px, titles clamped to 3 lines) so the reading
card starts above the fold at 1440x900. The reading
card shows the beat, its mock, the internals and ย้อนกลับ / "ถัดไป <title> →". The hash is `#at=<step id>` plus `&c=` for
non-default choices, so old step links still land on the beat that holds the step. With JS off, `StoryStatic.astro`
prints the beats as an ordered list with nested branches.

## Language and navigation

One rule for all content: the sidebar, page titles, beat titles, `ask`, `end`, arrow labels, the reading card, page
prose and this site's own buttons. Write Thai, and keep in English only the words a Thai developer already says in
English: model, API, request, system prompt, tool, tool call, turn, permission, hook, subagent, session, context,
compaction, error, retry, stream, schema, JSON, sandbox, workflow, MCP, skill, memory, Tab, CLI, file names, commands
and code ids. Write "สร้าง subagent แล้วรอรายงาน", not "สร้างเอเจนต์ลูกแล้วรอรายงาน".

Beat titles look like "Model ขอรัน `pnpm add zod`", "Geno ตรวจคำสั่งกับกฎของคุณ", "Geno หยุด turn แล้วถามคุณ" and
"คุณเห็นการ์ด “Run this command?”". `docs:check` limits a title to 60 characters, counted as a reader counts them:
a Thai vowel or tone mark rides on its consonant.

The one exception is a quote of real UI text. Mocks, fork option labels that name a real button, and quoted messages
stay exactly as the product shows them: Allow, Deny, "Run this command?", "Denied by you".

A page's `title:` is its H1, tab title and sidebar label; apply the rule above when you touch one. The page's Thai
`description` shows as one line under the H1. Chapter names are the `thai` column of the chapters in
`src/data/catalog.yaml`. The sidebar groups are, in order: เริ่มต้น, พื้นฐาน, Tool ในการใช้งานจริง, สถานการณ์,
แผนที่ระบบ, แนวคิดหลัก, อ้างอิง. `locales.root.lang` stays `th`.

## Writing beats for a page

1. Read the page's steps and fragments. Mark where a newcomer would say "and then". That is usually a hand-off between
   actors, a thing the user sees, or a decision.
2. Put a header there. Put one on the first step, on every fork arm's first step, and after a rejoin when the arms'
   last beats would read wrong for the shared steps.
3. Write the title as a short Thai sentence with the actor as subject ("Geno หยุด turn แล้วถามคุณ"), per the language
   rule above. Write the text for a reader who has never seen the code. Keep function names out of both; they belong
   in the internals.
4. Add `sees` where the user's screen changes. Use a typed mock if one fits, plain text otherwise.
5. Run `pnpm docs:check`, then `pnpm --filter @g-code/docs walk <base-url> <page path>` against a running dev
   server. It walks every branch in both views at 1440 and 390 and fails on spilled text or lanes that do not fit.

# Story layer for scenario tours

This file is for maintainers of `packages/docs`. It covers the site layout, the story layer of the tours, the payload
cards, the motion, and the checks. For a short Thai guide to running the site and writing a page, read
[README.md](README.md).

## Site layout: Astro pages in a Fumadocs frame

The site is an Astro build with a Fumadocs frame. These files own it:

| file | owns |
| --- | --- |
| `src/content.config.ts` | Two content collections: the pages (`src/content/docs/**/*.{md,mdx}`), checked by `pageSchema`, and the `meta.json` files. |
| `src/scenario/schema.ts#pageSchema` | The frontmatter a page takes: `title`, `description`, `full`, `scenario`, `payloads`. It is strict, so a key left over from Starlight (`sidebar`, `tableOfContents`, `template`, `hero`) fails the build, and `docs:check` reports it with the file and key. |
| `src/lib/source.ts` | The Fumadocs `loader` over both collections: the page tree, the URLs, and the search text. |
| `src/pages/[...slug].astro` | The one route. It renders the H1, the `description` line, and the page body. A tour page wraps the body in `StoryStatic.astro` and hydrates `Story.tsx` in it. |
| `src/components/Docs.tsx` | The frame as one React island: `DocsLayout` with the sidebar, and `DocsPage` with the table of contents. |
| `src/pages/api/search.ts` | The static search index the search dialog reads. |

A page is a Fumadocs `full` page when it has a `scenario` or sets `full: true` (the system map). A full page is wide
and has no table of contents. The home page draws its own buttons in `Home.astro`.

### Sidebar order lives in meta.json

Each folder under `src/content/docs` has a `meta.json` that lists its pages in sidebar order. The root `meta.json`
holds the groups and their separators. `pnpm --filter @g-code/docs meta` rewrites them all. A folder keeps the order
its `meta.json` lists, drops pages that are gone, and adds new pages at the end by file name. The scenario chapters
follow `src/data/catalog.yaml`. To place a new page, run the script, then move the page's name in its `meta.json`.

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

The model never talks to the panel. Its answer goes to the engine (`model` → `engine`), and the engine shows it
(`engine` → `panel`). When a story needs the reader to see the answer arrive, give the engine step that shows it its
own beat.

`links:` in `lanes.yaml` lists the actor pairs that the processes connect, in either direction. `docs:check` fails a
beat whose `from` and `to` differ and are not one of these pairs:

| pair | processes it crosses |
| --- | --- |
| `you`, `panel` | the person and the webview, the terminal, or VS Code |
| `you`, `machine` | the person and the OS, such as a notification or a file saved in another editor |
| `panel`, `engine` | the webview or extension host and the engine daemon, over ACP |
| `panel`, `machine` | the extension host and the disk, the OS, or Tab's llama-server on your machine |
| `engine`, `model` | the engine and the provider, or a child session's model inside the engine |
| `engine`, `machine` | the engine and its tools, the sandbox, MCP servers, and the web |

Tab completion never reaches the engine. The extension calls llama-server, a server on your machine, so the Tab
tour draws llama-server as `machine`.

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
- `packages/docs/src/data/recorded/<flow>.jsonl#line=N` is a recorded flow. See "Recorded flows" below.
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
| editor-request | คำขอที่ Geno ส่งให้ editor (ACP) |

- A card that shows a message, its `content`, or one of its blocks gets a chip row above the JSON listing the
  message's blocks in order (`thinking · text · tool_use edit · tool_use edit`). A chip scrolls the JSON to its
  block; a dashed chip is a block of the same message that the card does not show.
- A tool result card, and a logged `tool-result` event, names the call it answers ("ตอบ `tool_use edit`
  (toolu_…)") when the matching `tool_use` is in the same record or the same file.
- To show what the model got back from a tool, point at the `tool_result` block in the next request
  (`requests.jsonl` or `wire.jsonl`, `select: messages[-1].content[i]`), not at the session log's `output`.
- The first card on a page that shows a `tool_use` block carries a Thai line on reading one: `name`, `input`, `id`.
  In a story it is the first beat with one; on other pages, CSS hides it on every later `Payload`.

### Where the bytes come from

Each card names its provenance in the caption. `provenanceOf` in `src/scenario/payload.ts` reads it off the file
name, and the labels live in `Mock.tsx`:

| provenance | file | caption |
| --- | --- | --- |
| `recorded` | `wire.jsonl` | ไบต์จริงจาก wire log |
| `rebuilt` | `requests.jsonl` | request ที่ engine สร้างใหม่จาก session log ตอนเก็บผล |
| `logged` | a session log | event ใน session log |
| `scripted` | `src/data/recorded/<flow>.jsonl` | บันทึกจาก engine จริงกับ model จำลอง (commit …) |

A figure's title also says whether a real model answered: ข้อมูลจากการรันจริง, ข้อมูลจาก engine จริงกับ model
จำลอง, or both. A `scripted` card never claims that a real model answered.

### Recorded flows

Some moments appear in no real run, such as a subagent's permission card or a forced report. For those,
`pnpm docs:record` runs the real engine against the conformance harness's fake provider. Each flow, in a
`packages/engine/test/docs-record/flows-<name>.ts` file that imports only from `kit.ts` and is listed in `flows.ts`,
scripts the model's replies. The recorder writes every request the
engine sent, as sent, to `packages/docs/src/data/recorded/<flow>.jsonl`:

- Line 1 names the flow and the engine commit.
- Each request line is followed by the reply the scripted model streamed.
- A request the engine sent the editor over ACP (`{ acp, params }`, such as a permission card) follows the reply it
  came after.

To record one flow, name it: `pnpm docs:record child-permission`. With no name, the recorder runs every flow. It
replaces temp paths, session ids, call ids, and clock times, so a second run writes the same bytes except the commit.
Rerun the flows after an engine change that alters what they send. Then run `docs:check`, because a moved line breaks
the `#line=N` that a page points at.

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

## Story rules

On a page with any beat header:

- the first step (or `use:` entry) carries a header, so no step comes before the first beat;
- every fork arm starts with a header;
- every walk has 2 or more beats;
- every title is at most 60 characters (graphemes, so Thai marks do not count twice);
- a beat whose last step forks has `ask`;
- every mock validates, and every `payload` source resolves;
- every arrow joins two actors that `links:` in `lanes.yaml` connects, or one actor with itself;
- fragments carry no headers, because many pages share them.

A page with no header keeps working. Its tour shows a "story coming" state and the full step list.

## Rendering

`Story.tsx` is the tour island. It has two views over the same beats, Sequence (default) and Swim lanes,
with the choice kept in `localStorage`. Both draw a fork as a diamond whose branches end in end nodes.

Swim lanes read like a message flow. Each beat owns a column: a 240px node in its `from` lane (at most 2 lines at 14px)
and, when `to` differs, a message arrow straight down or up the column into a receiver bar in the `to` lane. A beat
the actor does alone has no message arrow. A thinner connector carries the walk from one beat to the next and changes
lanes only in the gutter before its target, so no arrow crosses a node. At a fork the diamond takes the receiver's
place (beside the node when the actor decides alone) and fans out to a column of chips: one per option, in option
order, each non-chosen chip naming its ending, and the walk goes on from the chosen chip. In Sequence, the
unpicked branches rest at 40% opacity so the chosen path leads. The current beat's arrows
are in the accent color, past ones solid, future ones faint. The lanes scroll sideways with the lane names pinned in a
column of their own, the current beat scrolls to the center, and an overview strip under the lanes shows the whole
walk and jumps to the beat nearest a click. One 72px row per lane keeps the reading card's title above the fold at
1440x900. `layoutLanes` returns the items and the routed arrow points, so the tests check the geometry directly. The
reading card shows the beat, its mock, the internals and ย้อนกลับ / "ถัดไป <title> →". The hash is `#at=<step id>` plus `&c=` for
non-default choices, so old step links still land on the beat that holds the step. With JS off, `StoryStatic.astro`
prints the beats as an ordered list with nested branches.

## Motion

`src/components/motion.ts` moves the diagram when the reader steps to a beat or picks at a fork. The views tag the
current beat's elements with a role in `data-mo`: `draw-x`, `draw-y`, `draw-path`, `ride`, `land`, `label`,
`recede`, or `end`. A fork's chips and branch arrows also carry `data-mo-fork`, and they move only when the reader
picks at that fork. `cueOf` decides what changed, and `perform` starts one Web Animation per tagged element.

- No animation fills forward. When an animation ends or is cancelled, the element returns to its resting CSS. A new
  beat cancels the last beat's motion, so nothing lags behind the reader.
- A swim-lane arrow draws on with `draw-path`. Its arrowhead is the path's `marker-end`, which stays off until the
  line reaches it.
- The dot (`ride`) travels the arrow's own path at one speed through the corners and ends on the receiver.
- Play advances after `dwell(beat)`, about 25 Thai characters a second, between 2.5 and 10 seconds. Play waits at a
  fork and stops at the last beat.
- With reduced motion on, a step starts no animation.

## Checks to run before you commit

Run the checks that cover what you changed. The browser checks need a running server. Start one on a free port with
`env -u ELECTRON_RUN_AS_NODE pnpm --filter @g-code/docs dev --port <port>`, and stop it with `astro dev stop` in
`packages/docs`.

| command | fails on |
| --- | --- |
| `pnpm docs:check` | a page, fragment, `lanes.yaml`, or `catalog.yaml` that does not parse; a stale frontmatter key; a code ref, emitted name, or turn end that the code does not have; a story rule above; a payload that does not resolve or shows part of a unit |
| `pnpm vitest run packages/docs scripts` | the compiler, story, layout, payload, motion-cue, and map tests |
| `pnpm --filter @g-code/docs walk <url> <page> ...` | spilled text, lanes that do not fit, a reading card below the fold, or a console error, on every branch of each page, in both views, at 1440 and 390 |
| `pnpm --filter @g-code/docs cards <url>` | a payload card that shows part of a unit, a label that disagrees with its JSON, or missing ids |
| `pnpm --filter @g-code/docs motion <url> [out] [page ...]` | a dot that misses its receiver, an arrowhead that shows mid-draw, stale animations after fast steps, play that skips a fork, or motion under reduced motion |
| `pnpm docs:build` | anything the static build rejects, such as a frontmatter key outside `pageSchema` |

Pass `walk` and `motion` pages as separate arguments. With no pages, they check three flagship tours.

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
`src/data/catalog.yaml`. The root `meta.json` sets the sidebar groups, in order: เริ่มต้น, พื้นฐาน, Tool ในการใช้งานจริง,
สถานการณ์, แผนที่ระบบ, แนวคิดหลัก, อ้างอิง. The route sets `<html lang="th">`.

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
   Run the other checks in "Checks to run before you commit" for what else you changed.

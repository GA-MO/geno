# Story layer for scenario tours

A tour has two layers. The fine steps (`lane`, `do`, `ref`, `emits`, forks, fragments) stay the truth that
`docs:check` verifies against the code. The story layer groups those steps into 8 to 15 beats that a newcomer reads
first. The fine steps of a beat open on demand under "Show internals".

## Data shape

A beat starts at a `beat:` header. The header sits on an acting step or on a `use:` entry:

```yaml
steps:
  - id: wants
    lane: model
    beat:
      title: Model asks to run pnpm add zod      # English, at most 60 characters
      text: >-                                  # Thai, 1 to 3 sentences, no function names
        โมเดลตอบกลับมาว่ายังไม่จบ มันอยากรันคำสั่ง `pnpm add zod` บนเครื่องของคุณก่อน
      from: model                               # optional; default: the actor of the beat's first step
      to: engine                                # optional; default: the actor of the beat's last step
      sees: { kind: step, label: pnpm add zod, status: running }   # optional, see "What you see"
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

| actor | name | lanes |
| --- | --- | --- |
| `you` | You | user |
| `panel` | Geno panel | panel, editor |
| `engine` | Geno engine | server, loop, policy |
| `model` | AI model | model, child |
| `machine` | Your machine | tool, external |

The who-acts badge comes from `from`: `you` is You, `model` is AI, and anything else is Geno.

## What you see

`sees` is either plain text or one typed mock, or a list of them. Each mock renders as a small, faithful copy of the
real UI. Mock text is the UI's English copy.

| kind | props |
| --- | --- |
| `permission` | `command`, `reason?`, `rule?`, `options?` (default: Allow, Deny, Always allow in this workspace, No, and tell the agent…), `chosen?`, `note?` |
| `question` | `question`, `options`, `chosen?` |
| `notice` | `text`, `detail?`, `actions?`, `tone?` (`info`, `warning`, `error`) |
| `step` | `label`, `status` (`running`, `done`, `failed`, `denied`), `note?`, `output?` |
| `message` | `from` (`you`, `geno`), `text`, `streaming?`, `footer?` |
| `toast` | `text`, `actions?` |
| `composer` | `state` (`idle`, `working`), `text?`, `header?` |
| `task` | `title`, `status` (`running`, `needs-input`, `done`, `failed`), `detail?`, `actions?` |
| `payload` | real wire data from a recorded run, see below |

### `payload`: real wire data

A payload mock shows what Geno sends the model, what the model returns, or what goes back as a tool result. Its JSON
comes from a recorded run under `docs/results/real-usecases/runs/<case>/<n>/`, read at build time:

```yaml
sees:
  - kind: payload
    direction: request                 # request | response | tool_result
    source: docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=9
    select: messages[-1]               # optional JSON path into the record; default: the whole record
    highlight: [content[0].tool_use_id] # optional paths, relative to the selection
    collapse: [content[0].content]      # optional paths shown folded
  - kind: payload
    direction: response
    source: docs/results/real-usecases/runs/A06-read-not-cat/1/session.jsonl#seq=9
    select: content
```

- `requests.jsonl#seq=N` is the request with that `seq`, expanded (`$prefix`, `$same`) the way the runs README says.
- `session.jsonl#seq=N` is the session event with that `seq`.
- Paths use dots and brackets. `[-1]` counts from the end.
- Instead of `source` + `select`, a page may give an inline `json:` excerpt. It still names `source`, which must exist.

`docs:check` fails when the file, the `seq`, the `select` path or a `highlight`/`collapse` path does not resolve.
The build trims the excerpt: strings over 240 characters keep their start and show "… 10,905 chars", and arrays over 6
items show "… 6 more". Several payloads in one `sees` render as tabs. The caption reads "From a real run: A06
read-not-cat, qwen3.8-flash" and links the source file.

## Checks

On a page with any beat header:

- the first step (or `use:` entry) carries a header, so no step comes before the first beat;
- every fork arm starts with a header;
- every walk has 2 or more beats;
- every title is English (ASCII letters dominate) and at most 60 characters;
- a beat whose last step forks has `ask`;
- every mock validates, and every `payload` source resolves;
- fragments carry no headers, because many pages share them.

A page with no header keeps working. Its tour shows a "story coming" state and the full step list.

## Rendering

`Story.tsx` replaces the old tour island. It has two views over the same beats, Sequence (default) and Swim lanes,
with the choice kept in `localStorage`. Both draw a fork as a diamond whose branches end in end nodes. The reading
card shows the beat, its mock, the internals and Back / "Next: <title> →". The hash is `#at=<step id>` plus `&c=` for
non-default choices, so old step links still land on the beat that holds the step. With JS off, `StoryStatic.astro`
prints the beats as an ordered list with nested branches.

## Writing beats for a page

1. Read the page's steps and fragments. Mark where a newcomer would say "and then". That is usually a hand-off between
   actors, a thing the user sees, or a decision.
2. Put a header there. Put one on the first step, on every fork arm's first step, and after a rejoin when the arms'
   last beats would read wrong for the shared steps.
3. Write the title as an English sentence with the actor as subject ("Geno pauses the turn and asks you"). Write the
   Thai text for a reader who has never seen the code. Keep function names out of both; they belong in the internals.
4. Add `sees` where the user's screen changes. Use a typed mock if one fits, plain text otherwise.
5. Run `pnpm docs:check`, then walk every branch on the dev server.

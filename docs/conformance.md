# Conformance with Claude Code

The suite in `packages/engine/test/conformance/` checks Geno against the conformance tests in `research/claude-code-harness/spec/05-conformance-tests.md`. Each test title starts with its ID, such as `T-TOOL-12`. A test of a parity-doc row with no spec test uses the row's ID, such as `A/A-10`. A test asserts `is_error` and meaning, never Claude Code's exact bytes. A test of what the model sees runs on the Anthropic wire and on the OpenAI-compatible wire.

The study behind the IDs, and the plan unit that owns each one, are in [claude-code-parity.md](claude-code-parity.md).

Run the suite with `pnpm vitest run --project unit packages/engine/test/conformance`.

The suite runs inside the `unit` vitest project, not in a project of its own. `--project unit` is hard-coded in `scripts/test-affected.ts`, in `pnpm test:all` and in every unit's gate, so a separate project would drop the suite from all of them.

`scripted(wire, script)` in `scripted.ts` drives the real engine for a test. It starts a git workspace and a fake provider on the chosen wire that answers the model calls in order. `cli` runs the `gcode` command line, `io` serves the engine to an editor over ACP, and `seen` reads each request as the model saw it: the tool results and the text that came after the model's last turn.

## Agent loop (P1)

| ID | Claude Code | Geno | Status | Test |
|---|---|---|---|---|
| T-LOOP-01 | Every `tool_use` gets a result with its id, in call order, after PreToolUse runs for all of them. | Results carry their ids in call order. There is no PreToolUse yet (P14). | partial: the ordering half passes | `loop.conformance.test.ts`, both wires |
| T-LOOP-02 | A call a hook denies does not stop the other calls of its batch. | A call the approval policy denies gets a `denied` result, and the calls before and after it run. Hooks come in P14. | pass | `loop.conformance.test.ts`, both wires |
| T-LOOP-04 | At `max_tokens`, the cut-off `tool_use` does not run, and a reminder says to continue. | The cut-off call gets an error result that says the output limit cut it short and to continue with smaller calls. The complete calls before it run. A second cut-off in a row ends the run. | pass (was fail: on the Anthropic wire the cut-off command ran) | `loop.conformance.test.ts`, both wires |

P1 also fixed rows that have no Claude Code conformance test:

| ID | Check | Status |
|---|---|---|
| A/A-10 | A Stop during a tool batch keeps the result of each call that finished. It answers the call that was running as "interrupted by user… may have partly run" and the calls that never started as "did not run", all before the abort. The next prompt runs none of them. Checked from the command line and from an editor over ACP, in `loop.conformance.test.ts`. A log written before P1 has no such answers; `loopStep` answers its stopped calls on the next run instead (`core/test/loop.test.ts`). | pass (was fail), both wires |
| A/A-08 | A `model_context_window_exceeded` stop compacts the context and sends the request again once, in `loop.conformance.test.ts`. | pass (was fail), Anthropic wire only: Chat Completions has no such stop |
| B/B-08 | T-LOOP-02 above. | pass |

## Tools (P2)

| ID | Claude Code | Geno | Status | Test |
|---|---|---|---|---|
| T-TOOL-12 | Bash exit 1 is `is_error`, with `Exit code 1` before the output. | `bash` with a non-zero exit, or killed at its timeout, returns an error result. It starts with `Exit code N` and keeps the trailing `[exit code N]` line. On the OpenAI-compatible wire the tool message starts with `[error]`. | pass (was fail) | `tools.conformance.test.ts`, both wires |

P2 also fixed rows that have no Claude Code conformance test. Their checks are unit and e2e tests:

| ID | Check |
|---|---|
| B/B-19, B/B-04 | T-TOOL-12 above. `plugins.e2e.test.ts` expects a sandbox-refused command as an error result. |
| N-01 | `tools.test.ts`: `grep` with `path: 'packages/core/src'` finds `pendingToolUses` in this repository. A `path` that names a directory or a file searches it, `glob` narrows it, and a search that looked at no file is an error. |
| B/B-25, C/C-77 | `plugins.test.ts` renders geno-tools text with and without the `agent` tool. `plugins.e2e.test.ts` checks that a run with `agentTool` points the model at the text that maps `Agent` to `agent`. |
| A/B-12 (text) | `context.test.ts` pins the skill listing, which tells the model to call the `skill` tool. |

## Agents (P4)

| ID | Claude Code | Geno | Status | Test |
|---|---|---|---|---|
| T-AGENT-02 | A report with instruction-shaped text comes back with every line indented, `<` neutralized, and a `[harness: subagent output matched…]` line first. | `<subagent_report>` keeps its fence and status attributes. Every line of the report is indented by two spaces. Every Geno harness tag in it loses its `<` and every line that starts like a Geno notice (`[Geno`, `[Background command`, `[Monitor`, `[Scheduled wake-up`, `[PR watch`) loses its `[`, both to `‹`. A report that matches a pattern in `INSTRUCTION_PATTERNS` (packages/core/src/fence.ts) gets a `[Geno: this report matched instruction-shaped patterns (…)]` line first. After the fence, the parent reads that the report is not from the user and the permission-laundering sentence. | pass (was fail) | `agents.conformance.test.ts`, both wires |
| T-AUTO-04 | The security monitor screens a hand-back before the parent sees it. | Adapted: no extra classifier call per report. When a subagent report reached the parent after the user's request, the classifier input for the parent's next flagged command or MCP call says "A subagent report preceded this action". | pass (adapted, was fail) | `agents.conformance.test.ts`, Anthropic wire (the classifier always runs on Model Studio) |

P4 also covers rows whose checks are unit tests:

| ID | Check |
|---|---|
| A/A-14, C/C-24, C/C-25 | `subagent.test.ts` pins the indent, the banner, Geno's column-zero notes and the text after the fence. `fence.test.ts` checks that every pattern has examples that match and that an ordinary report matches none. |
| B/B-83 | `classifier.test.ts` (core) checks when `classifierInputOf` sets the flag and that the note sits outside every fence. `classifier.test.ts` (engine) sends the `report-delete-src` eval case to a fake classifier. The live verdict comes from `gcode eval classifier`, which needs a Model Studio key. |
| D7 | T-AGENT-02 above. Background-end notices, monitor matches, PR-watch text and a parent's message to its child go through the same `neutralize`. |

## Every conformance test

Matrix D of the parity study checked the 98 tests against `main` at ef7596e: 24 pass, 5 pass+, 33 partial, 29 fail, 6 n/a, 1 unverified. Its per-test verdicts were not kept in the repository. So this table gives, for each test, the parity doc's verdict and the unit that closes it, and the status column records only what the suite shows: **pass**, **partial** (a test covers part of it, as the unit's section says), or **no test yet**. A unit that adds a test updates its row here.

| ID | Parity verdict | Unit | Status |
|---|---|---|---|
| T-LOOP-01 | adopt; at parity | P14 | partial |
| T-LOOP-02 | adopt | P1 | pass |
| T-LOOP-03 | adopt | P15 | no test yet |
| T-LOOP-04 | adopt | P1 | pass |
| T-LOOP-05 | keep Geno's | none | no test yet |
| T-TOOL-01 | keep Geno's, adopt | P27 | no test yet |
| T-TOOL-02 | keep Geno's, adopt | P27 | no test yet |
| T-TOOL-03 | keep Geno's, adopt | P27 | no test yet |
| T-TOOL-04 | keep Geno's, adopt | P27 | no test yet |
| T-TOOL-05 | keep Geno's | none | no test yet |
| T-TOOL-06a | deliberate | none | no test yet |
| T-TOOL-06b | adopt | P27 | no test yet |
| T-TOOL-07 | keep Geno's | P10, P23 | no test yet |
| T-TOOL-10 | keep Geno's, adopt | P27 | no test yet |
| T-TOOL-11 | adapt | P27 | no test yet |
| T-TOOL-12 | adopt | P2 | pass |
| T-TOOL-08 | adopt | P27 | no test yet |
| T-TOOL-09 | adopt | P36 | no test yet |
| T-ASM-01 | adapt | P23 | no test yet |
| T-ASM-03 | adopt | P5 | no test yet |
| T-ASM-04 | at parity | none | no test yet |
| T-ASM-05 | adopt | P24 | no test yet |
| T-ASM-06 | adapt | P23 | no test yet |
| T-ASM-07 | adopt | P11 | no test yet |
| T-ASM-08 | skip | none | no test yet |
| T-ASM-09 | at parity | none | no test yet |
| T-ASM-10 | adopt; adapt | P8 | no test yet |
| T-ASM-11 | adopt | P9 | no test yet |
| T-ASM-13 | at parity | none | no test yet |
| T-ASM-15 | adapt | P36 | no test yet |
| T-ASM-16 | at parity | none | no test yet |
| T-ASM-17 | adapt | P6 | no test yet |
| T-ASM-18 | deliberate | none | no test yet |
| T-ASM-14 | at parity | none | no test yet |
| T-DEFER-01 | keep Geno's | none | no test yet |
| T-DEFER-02 | keep Geno's | none | no test yet |
| T-DEFER-03 | adapt | P27 | no test yet |
| T-DEFER-04 | adapt | P27 | no test yet |
| T-MCP-01 | adopt | P10 | no test yet |
| T-MCP-02 | adapt | P38 | no test yet |
| T-MCP-03 | adapt | P10 | no test yet |
| T-PERM-01 | keep Geno's, adopt | P28 | no test yet |
| T-PERM-02 | deliberate | none | no test yet |
| T-PERM-03 | adapt | P32 | no test yet |
| T-PERM-04 | adapt | P31 | no test yet |
| T-PERM-05 | adapt; adopt | P3, P28, P14 | no test yet |
| T-PERM-09 | at parity | none | no test yet |
| T-PERM-10 | adapt | P28 | no test yet |
| T-PERM-11 | keep Geno's | none | no test yet |
| T-PERM-12 | deliberate; adopt | P14 | no test yet |
| T-PERM-06 | adopt | P14 | no test yet |
| T-PERM-07 | keep Geno's, adopt | P20 | no test yet |
| T-PERM-08 | adopt | P5 | no test yet |
| T-AUTO-01 | skip | none | no test yet |
| T-AUTO-02 | keep Geno's | none | no test yet |
| T-AUTO-04 | adapt, skip | P4 | pass |
| T-AUTO-03 | skip | none | no test yet |
| T-HOOK-01 | adapt | P13 | no test yet |
| T-HOOK-02 | adopt | P14 | no test yet |
| T-HOOK-03 | adopt, keep Geno's | P15 | no test yet |
| T-HOOK-04 | adopt | P15 | no test yet |
| T-HOOK-05 | adapt | P32 | no test yet |
| T-HOOK-06 | adopt | P13 | no test yet |
| T-HOOK-07 | adapt | P13 | no test yet |
| T-HOOK-08 | adopt | P13 | no test yet |
| T-HOOK-09 | adopt | P13 | no test yet |
| T-HOOK-10 | adapt | P13 | no test yet |
| T-HOOK-11 | adopt | P13 | no test yet |
| T-BG-01 | keep Geno's, adopt | P19 | no test yet |
| T-BG-02 | keep Geno's | none | no test yet |
| T-BG-03 | adopt | P19 | no test yet |
| T-BG-04 | adapt | P6 | no test yet |
| T-BG-05 | adapt | P6 | no test yet |
| T-BG-06 | adopt | P19 | no test yet |
| T-SKILL-01 | keep Geno's | none | no test yet |
| T-SKILL-02 | at parity | none | no test yet |
| T-SKILL-03 | at parity | none | no test yet |
| T-MEM-01 | adopt | P8 | no test yet |
| T-MEM-02 | keep Geno's | P11 | no test yet |
| T-MEM-03 | adapt | P22 | no test yet |
| T-CTX-01 | adapt | P7 | no test yet |
| T-CTX-02 | keep Geno's | none | no test yet |
| T-CTX-03 | at parity | none | no test yet |
| T-CTX-04 | skip | none | no test yet |
| T-CTX-05 | adopt, adapt | P26 | no test yet |
| T-CTX-08 | keep Geno's, adapt | P23 | no test yet |
| T-CTX-06 | skip | none | no test yet |
| T-CTX-07 | keep Geno's | none | no test yet |
| T-AGENT-01 | deliberate, adapt; deliberate | P21 | no test yet |
| T-AGENT-02 | adapt | P4 | pass |
| T-AGENT-03 | adapt | P17 | no test yet |
| T-AGENT-04 | adopt | P18 | no test yet |
| T-AGENT-05 | adapt | P20 | no test yet |
| T-WF-01 | adapt | P34 | no test yet |
| T-WF-02 | adopt | P33 | no test yet |
| T-PERSIST-01 | keep Geno's | none | no test yet |
| T-PERSIST-02 | adopt | P11 | no test yet |
| T-PERSIST-03 | adapt | P22 | no test yet |

# U18 brief: Noodle moves, and a dino-only start page

The user wants the dino to move: to change pose with the work (a notebook when reading, a pencil when editing), and to run, jump, turn around and flex. They also want a cooler start page with no frame around the dino. They saw prototypes on 2026-10-05 and asked for a geek pose that pulls out a laptop to code. The start page is the dino alone; see below.

## Sprites

- **Data shape first.** The dino is a 24×24 pixel grid, as in `packages/extension/media/noodle-box-a-avatar.svg`: green `#5fc79a`, white `#ffffff` and dark `#14231f`.
  - A pose is a list of frames.
  - A frame is the base body plus overlays: eye (open, blink, look left, look down, happy), tail (down, up), legs (stand, step a, step b, tucked), arms (none, half, flex), a held prop (notebook, notebook and pencil, laptop with a lid height and code lines, clipboard), glasses, and floating marks (thought dots, "?", sweat drop, sparkle, dust).
  - Write it as a pure table in core or the extension, and have a renderer draw it to a canvas or to SVG rects. A new pose is a new row.
- **Poses and when they show:**

| Pose | When |
|---|---|
| idle (blinks, tail flicks) | empty chat; a still frame in finished turns |
| thinking (dots over the head) | waiting on the model with no tool running |
| reading (open notebook, eyes scan, pages turn) | read, grep, glob, list, skill |
| coding, the geek pose (pulls a laptop up from below, opens the lid, puts on glasses, then types while colored code lines fill the screen) | edit or create of a code file; the pull-out plays once per turn, then typing loops |
| writing (paper notebook and a moving pencil) | edit or create of a non-code file such as Markdown, JSON or a config |
| running in place (legs, bob, dust) | bash, check, MCP calls |
| planning (clipboard, ticks appear) | Plan mode turns |
| asking ("?" bobbing over the head) | a pending approval, remember or ask_user card |
| hop with sparkle, once | the turn ends |
| flex, once | the turn ends and its checks passed |
| sweat drop | a step failed |
| turn to face the user | the moment the user sends a message |

- Pixels stay crisp. Draw only at integer scales: 1× (24 px) for the still avatar in finished turns, 2× (48 px) for the working dino next to the current step, and 4× on the start page.
- **No frame.** The dino has no tile, background or border anywhere. Remove `.avatar` and `.hero` backgrounds and outlines. High contrast keeps a plain outline only if the shape would otherwise disappear.

## In the chat

The user confirmed on 2026-10-05 that the props and the other moves belong in the chat.

- **The working dino.** It is 48 px, beside the current step of the running turn, with the pose table above: notebook, laptop and glasses, pencil, clipboard, running in place, "?", and sweat.
- **Turn end.**
  - The turn ends and its checks passed: it flexes once.
  - The turn ends without checks: it hops or somersaults once, picked at random.
  - The dino then becomes the still 24 px avatar of the finished turn.
- **Peek.** When the chat is idle after a turn, the dino's head peeks over the top edge of the composer. Its eyes follow the mouse inside the panel. It ducks behind the composer while the composer has focus or holds text, and hides while a turn runs.
- **Prototype.** The interactive panel prototype the user saw (the working poses, the folded finished turn and the peek) is the reference.

## The peek, upgraded (user request, 2026-10-06)

U18a's peek shows only the head over the composer's top edge. The user wants Noodle to grip the edge with both hands and do things, not just pop up and vanish. A prototype was shown and is the reference.
- **Body, not a floating head.** The user said the first prototype looked like a severed head with loose hands. The peek therefore shows one connected body: the head, the neck running all the way down to the edge, the top of the chest with its white belly above the edge, and two arms running from the chest's sides down to the hands. The hands are 3×2, with knuckle pixels in a darker green (`#4fae86`), and grip the composer's top edge over the rainbow border. Everything below the edge is clipped by the composer, so climbing and ducking slide the whole body, never the head alone. The second prototype is the reference. Draw it at 2× (about 46 px above the edge at full climb), not the 3× of the prototype; the user found 3× too big. Integer scale only, so the pixels stay crisp.
- **Moves.** Each is a row in the pose table:

  | Move | Frames |
  |---|---|
  | Climb up | head rises, hands land on the edge, blink |
  | Look around | eyes left, right, then up toward the pointer |
  | Wave | one arm leaves the edge and waves above it, with happy eyes |
  | Drum fingers | hands tap the edge in turn |
  | Sink down, sleepy | the body sinks a little lower behind the edge, slow blinks |
  | Yawn | mouth open, eyes closed, a small "z" |
  | Wink | one eye closes |
  | Duck down | hands let go and it slides behind the composer |

- **When each plays:**
  - Climb up plays when the chat becomes idle.
  - While idle, a weighted random move plays every 6 to 12 s, mostly look around and drum fingers.
  - Chin rest and yawn come only after 60 s or more of idle.
  - Wave plays once when the user returns to the window after being away for a while.
  - Duck down plays the moment the composer gets focus or text, and while a turn runs.
  - The eyes still follow the pointer between moves.
- **Motion budget.** Same as U18a: it pauses when the window is unfocused or the view is hidden. Under reduced motion or high contrast it shows only the still head and hands, with no moves and no tracking.
- **Owner.** U18b builds this, together with the working dino.

## Start page: just the dino

On 2026-10-05 the user went through Horizon, a commit-graph ground, a desk scene and a terminal card, then chose the simplest one: the dino alone, with no other objects.

- **No objects.** No ground line, obstacles, desk, clouds or props. The only extra is a soft shadow under the dino that shrinks while it is in the air.
- **Moves.** The dino wanders on its own. It walks (most of the time), runs, turns with a small hop at an edge, jumps, does a somersault (the sprite rotates in 90° steps, so the pixels stay crisp), sits (blinking and flicking its tail), waves and flexes. A weighted random pick chooses the next move.
- **Click.** Clicking the dino makes it somersault.
- **Below the dino:**
  - `geno` in the monospace font with a blinking cursor;
  - the project name and the git branch;
  - a "Continue" list of this project's three most recent sessions, with relative times; a click loads that session.
- **Prototype.** The interactive prototype shown to the user is the reference for the moves and their timing.
- **Themes.** It uses the glass tokens, light and dark. In high contrast it is native and still.

## Motion budget

- The animation runs at about 12 frames a second, on a timer or requestAnimationFrame. It stops when the webview is hidden, when the window loses focus, and on the start page once a turn begins.
- Under `prefers-reduced-motion` the dino shows each pose's first frame and never moves across the page.
- Only the dino of the running turn animates. Finished turns are still.
- Measure: a CPU profile of 10 seconds of start-page animation and of a running turn. Report the main-thread busy percentage, and keep it low enough not to be noticed, with a target under 2%.

## Split, so work runs in parallel

- **U18a starts now**, alongside U13 and U17. It covers:
  - the sprite module and the full pose table (every pose, including the working ones, unit-tested);
  - the renderer;
  - the dino-only start page;
  - removing every dino frame;
  - the peek over the composer.

  It does not touch the rendering of turns.
- **U18b starts after U17 merges.** It covers the 48 px working dino beside U17's current-step line and the turn-end moves.

## Coexist

U17 (folding finished turns) changes the same rendering in `render.ts`. U18 starts after U17 merges and builds on its view model: the working dino sits beside U17's "current step" line.

## Check

- Unit tests:
  - the pose table (every pose's frames are inside the 24×24 grid and use only the palette);
  - the step-kind to pose mapping;
  - the turn-end rule (flex only when checks passed);
  - the start page's recent-sessions selection.
- Integration tests in VS Code:
  - the start page renders the scene, the name, the branch and recents, and a recent session loads on click;
  - a running fake turn switches poses as its steps change;
  - reduced motion stops movement;
  - no dino element has a background or border.
- Screenshots in dark glass, light glass and high contrast in `docs/media/u18/`, each viewed. Also a short GIF of the start page and one of a working turn.
- `pnpm typecheck && pnpm test && pnpm build`, and the `.vsix` clean-install test, also with `GCODE_VSCODE_VERSION=1.109.2`.

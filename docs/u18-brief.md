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

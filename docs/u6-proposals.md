# U6a proposals: three looks and three dinosaurs

These are throwaway prototypes for choosing U6c's direction. Each direction is a static page under `prototypes/u6/<direction>/`, fed the same fixed transcript from `prototypes/u6/shared/transcript.js`. Every color comes from VS Code's theme variables, mixed with `color-mix` where a tint is needed.

The screenshots come from a real VS Code webview. A throwaway extension in `prototypes/u6/harness/` shows each page in a sidebar view; `pnpm exec tsx prototypes/u6/harness/capture.mts` relaunches VS Code and recaptures every image. Each direction has four moments:

- the finished first turn, from the top (`<direction>-dark.png`, `-light.png`);
- the second turn waiting on a command, scrolled to the end (`-permission-`);
- an answer mid-stream, with the caret and the live stop button (`-streaming-`);
- the empty panel (`-empty-`).

`<direction>-hc.png` shows the finished turn in Default High Contrast. It checks that each direction holds up when the theme makes button colors transparent.

The activity bar shows Noodle's mono icon in every screenshot. Each direction uses a different dinosaur as its avatar, but you can pair any direction with any dinosaur.

## Directions

### Trail

The run is a path. Every step becomes a node on one vertical rail, which runs from the prompt to the answer and ends at the diff card. Consecutive reads and edits collapse into one row of file chips.

It feels modern because the process is visible at a glance and the steps carry state. A green node means done, a dashed node means a thought, and a pulsing amber node with a dashed rail below it means g-code is waiting on you. The user's message is a tinted bubble, and the composer floats as a raised card with context chips and a round send button.

Tradeoffs:

- It is the closest of the three to VS Code's own chat, so it is the safest choice and the least distinctive.
- The rail costs 30px of width on every line of the answer.
- The grouped chips hide each call's timing; you open a row to see it.

Images:

- `docs/media/u6-proposals/trail-dark.png`, `trail-light.png`
- `docs/media/u6-proposals/trail-permission-dark.png`, `trail-permission-light.png`
- `docs/media/u6-proposals/trail-streaming-dark.png`, `trail-streaming-light.png`
- `docs/media/u6-proposals/trail-empty-dark.png`, `trail-empty-light.png`
- `docs/media/u6-proposals/trail-hc.png`

### Folio

Each exchange is one raised sheet, and the prompt is its title. Under the title, the run is a segmented strip with one colored segment per step and a count for each kind of step; the answer reads like a page, with code and diagrams running edge to edge.

It feels modern for three reasons. The sheets have soft depth, the type is larger for reading, and the run is summarized rather than logged, the way current agent apps show work. The diagram sits on a dotted canvas, the diff is a tabbed attachment at the foot of the sheet, and a waiting run turns its strip into amber hazard stripes. The permission card uses two equal buttons, so Allow and Deny are equally easy to reach.

Tradeoffs:

- It shows the least of the run: you open Steps to see individual calls.
- The sheet's edges come from the editor background against the sidebar background. In Dark Modern that contrast is small, so the shadow does most of the work.
- Sheets cost vertical space in long sessions.

Images:

- `docs/media/u6-proposals/folio-dark.png`, `folio-light.png`
- `docs/media/u6-proposals/folio-permission-dark.png`, `folio-permission-light.png`
- `docs/media/u6-proposals/folio-streaming-dark.png`, `folio-streaming-light.png`
- `docs/media/u6-proposals/folio-empty-dark.png`, `folio-empty-light.png`
- `docs/media/u6-proposals/folio-hc.png`

### Blocks

The panel works like a modern terminal. Turns are full-width blocks with a colored left edge, and the prompt sticks to the top as you scroll. Every tool call is one aligned log line with a status, tool, argument, result and duration, and every action has a key.

It feels modern in the way Warp and current coding CLIs do: dense, honest about what ran, and fast to drive from the keyboard. The pixel-art dinosaur sets the visual language. Cards, keys and status marks have stepped two-pixel corners instead of rounded ones, and the usage footer is a segmented status strip.

Tradeoffs:

- Monospace prompts and logs read as technical, and some will find the panel cold.
- The stepped corners use `clip-path`, which cannot draw a border. Surfaces are told apart by fill alone, which is weakest in High Contrast.
- Showing every call doesn't scale to a run with forty tool calls without folding.

Images:

- `docs/media/u6-proposals/blocks-dark.png`, `blocks-light.png`
- `docs/media/u6-proposals/blocks-permission-dark.png`, `blocks-permission-light.png`
- `docs/media/u6-proposals/blocks-streaming-dark.png`, `blocks-streaming-light.png`
- `docs/media/u6-proposals/blocks-empty-dark.png`, `blocks-empty-light.png`
- `docs/media/u6-proposals/blocks-hc.png`

## Dinosaurs

All three are original and drawn on a 24x24 grid. They are not traced from any existing character, and none is a T-rex. `prototypes/u6/dinos/make_dinos.py` builds each one from its palette grid as three files: a mono activity-bar SVG with the eye cut out, a colored SVG avatar, and a 128px PNG icon on a tile with stepped corners. The same script builds the comparison sheet, `docs/media/u6-proposals/dinos.png`, which shows each dinosaur at 16, 24 and 128px on Dark Modern and Light Modern backgrounds.

- **Noodle** is a mint long-neck with a pink cheek, looking up. Its tall neck is the clearest silhouette at 16px.
- **Plato** is a lilac stegosaurus with three amber back plates. It is the most playful, though at 16px the plates blur into a spiky blob.
- **Frill** is a peach triceratops with a red frill and cream horns. It is the warmest of the three; at 16px the frill and head merge.

Files: `prototypes/u6/dinos/{noodle,plato,frill}-mono.svg`, `-avatar.svg` and `-128.png`.

### Boxy Noodle

After the user picked Noodle, they asked for a blockier version. Three variants keep Noodle's palette, eye and blush, and drop every diagonal step. They get more boxy from A to C. The same script builds them, and `docs/media/u6-proposals/noodle-boxy.png` compares them against the original Noodle.

- **Box A** is Noodle with straight edges: a rectangular head on a long neck, a long flat body, a straight tail and thick square legs.
- **Box B** is chunky: a near-cube body, a big square head on a short thick neck, a stub tail and stubby block legs.
- **Box C** is almost a box: a plain box body with a small box head on a thin neck, a nub tail and one-row feet.

Files: `prototypes/u6/dinos/noodle-box-{a,b,c}-mono.svg`, `-avatar.svg` and `-128.png`.

## Recommendation

Use Trail with Noodle. Trail answers the original request most directly, because a run reads as a process in a single glance. It also keeps VS Code's own conventions, so it fits the editor in every theme with the fewest special cases. Noodle is the only dinosaur that stays recognizable as a mono 16px mask.

If Trail feels too safe, consider borrowing Blocks' aligned timings for an expanded rail row. That costs little and adds the detail Trail hides.

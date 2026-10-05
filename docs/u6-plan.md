# U6: diagrams, a modern look, and a pixel dinosaur

The user asked for three things: the chat should render flows, diagrams and processes; the panel should look more modern than the U4 native style; and the icon should be a cute pixel-art dinosaur.

## Order

1. In parallel:
   - U6a builds three design directions and three dinosaur variants as real screenshots in VS Code, for the user to choose. Look and feel is the user's call, so nothing is implemented until they pick.
   - U6b renders diagrams in the chat. It does not depend on the chosen look, because diagrams take their colors from the theme.
2. U6c implements the chosen direction and dinosaur, after the user picks.

## U6a. Design directions (prototype, throwaway)

- Three directions that are each clearly more modern than U4 and still readable in every VS Code theme. Colors derive from the theme's CSS variables (`color-mix` is fine), so dark, light and high contrast all work. Each direction is a static HTML page fed the same transcript: a user message, streamed markdown with a code block, a diagram, tool rows, a diff card, a permission card, the usage footer, and the empty state.
- Each direction changes the things that make a chat feel modern: message layout, an avatar, depth (soft surfaces, borders, subtle shadow), radius, spacing, type scale, motion (streaming caret, tool-row transitions, a thinking indicator), and how a run's steps read as a process (a vertical timeline with connectors, for example).
- An original pixel-art dinosaur. Do not copy or trace an existing character, including Chrome's offline T-rex. Deliver three variants, each as:
  - a monochrome 24x24 SVG for the activity bar, which VS Code renders as a single-color mask;
  - a colored SVG avatar for the chat;
  - a 128x128 PNG extension icon.

  Pixel art means whole-pixel rects on a grid with `shape-rendering: crispEdges`.
- Screenshots of each direction in Dark Modern and Light Modern inside a real VS Code webview, plus an icon sheet showing all three dinosaurs at 16, 24 and 128 pixels, in `docs/media/u6-proposals/`.

## U6b. Diagrams in chat

- Render ```` ```mermaid ```` code blocks in assistant messages as diagrams in the webview: flowcharts, sequence diagrams, state diagrams, and the like. Themed from VS Code colors, re-themed when the user switches theme, and redrawn when the panel resizes.
- Safe by construction. The webview's Content Security Policy stays strict, with no `unsafe-eval` and no remote resources. Mermaid's output is sanitized. A diagram that fails to parse shows its source as a code block, with the parse error in a muted line.
- The diagram library is loaded only when a transcript first contains a diagram, so the panel's first paint stays fast. Report the bundle size it adds.
- Each diagram has a toolbar: copy the source, and open it full size in an editor tab.
- The agent's prompt tells the model it may answer with a mermaid diagram when a flow, architecture or process is clearer drawn than written. That text sits in the stable cached prefix.
- Check: unit tests for the markdown-to-diagram path, a VS Code integration test that renders a flowchart and a broken diagram, screenshots in dark, light and high contrast, and a live smoke where `qwen3.8-flash` is asked to explain this repo's request flow as a diagram, under $0.02.

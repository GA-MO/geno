# UI gallery and themes

The UI gallery shows every state of the chat panel on one page, under each VS Code theme, so you can change the panel's look and see every state change with it. Each state runs the real panel bundles, built from source, against a fake extension host. The same states run in a webview test, so a state you add to the gallery is also checked in all four themes.

![The gallery grid of turn states in Dark Modern](ui-gallery/grid-dark.png)

## Run the gallery

1. Start the server from the repository root:

	```sh
	pnpm ui
	```

	It prints `Geno UI gallery: http://127.0.0.1:5390/`. Set `GCODE_UI_PORT` to use another port. The server listens on 127.0.0.1 only.

2. Open the URL in a browser.

The server builds the panel's browser bundles from `BUNDLES` in `packages/extension/build.mts` and watches the sources. After you save a file in `src/chat` or `test/gallery`, it rebuilds and the page reloads with your controls kept. A failed build shows its error in a red bar above the frames.

To stop the server, press Ctrl+C.

## Find your way around the page

- **The sidebar** lists every state by group. Click a group name to see its states in a grid. Click a state to see it alone. **Every state** shows all of them.
- **States and Design system** switch between the panel states and the design-system page.
- **Grid and Single** pick many frames at once or one tall frame.
- **Theme** picks one of the four themes captured from a real VS Code window: Dark Modern, Light Modern, Dark High Contrast, and Light High Contrast. The dumps are in `packages/extension/test/webview/themes`.
- **Style**, **Detail**, and **Review** set the look as `gcode.ui.style`, `gcode.chat.detail`, and `gcode.review.mode` do. A state that needs a detail, such as full detail for a diff, keeps it.
- **Width** sets the panel width to 300, 420, or 600 pixels, or to the number you type.
- **Reduced motion** makes the panel's stylesheet and its `matchMedia` checks answer as if the system asked for reduced motion.
- **Tokens** opens the token panel.

A red badge on a frame counts its problems: errors the page logged, CSP refusals, and elements that run past the panel edge. Hover the badge to read them.

![The light grid](ui-gallery/grid-light.png)

The design-system page reads the panel's stylesheet as the page loaded it. It shows every Geno token with its value, the type scale, the spacing, the radii, every codicon that `src/chat` draws, and each Noodle pose and peek move. Nothing on it is copied by hand, so it stays true when the CSS changes.

![The design-system page](ui-gallery/design-dark.png)

## Add a state

Every state is one entry in `FIXTURES` in `packages/extension/test/gallery/fixtures.ts`:

```ts
{
	id: 'tool-failed',
	group: 'Tools',
	title: 'A failed command',
	look: { detail: 'full' },
	play: async ({ host }) => {
		await host.act(turnStart('t0', 'Run the tests'), toolStart('tu_t', { name: 'bash', input: { command: 'pnpm test' } }));
		await host.act(toolEnd('tu_t', 'failed', 'FAIL src/login.test.ts'), ended());
	},
},
```

`play` gets a `Stage`. `stage.host` is the `FakeHost` from `test/webview/host.ts`. Call `host.act` with the actions the extension dispatches, and `host.post` with any other message the extension sends, such as `show-settings` or `mcp`. The helpers in `test/webview/turns.ts` build the common actions. To answer a message the panel sends, register a handler with `host.on`, as the `history` state does for `list-sessions`. To act as the user, use `stage.click`, `stage.fill`, and `stage.reveal`. To wait for the panel, use `stage.shows`.

The state then appears in the gallery and in `packages/extension/test/webview/gallery.webview.test.ts`. That test opens each state at 300 pixels in each of the four themes. It fails when the page logs an error or when anything runs past the panel edge. To run it alone:

```sh
pnpm vitest run --project webview packages/extension/test/webview/gallery.webview.test.ts
```

## Make a theme

1. Click **Tokens**. The token panel lists every Geno custom property, grouped by prefix. Each row shows the value the panel computes in the current theme.
2. Pick the theme you want to change. Your edits apply to that kind of theme: dark, light, high contrast, or high contrast light.
3. Type a CSS value, or pick a color. Every frame updates at once. A row you changed shows its name in blue, with **Reset** beside it.
4. To make the theme for another kind, switch the theme and edit again.
5. Click **Export**. The gallery saves `geno-theme.json`.

![A token change in the gallery](ui-gallery/tokens-dark.png)

To start from a theme someone shared, click **Import** and choose its file. The gallery drops what the extension would drop and lists why.

The gallery keeps your edits in the browser's storage. They survive a reload of the page, not a change of browser.

## Share and use a theme

`geno-theme.json` holds the value of the `gcode.appearance.tokens` setting. To use it, paste it into your user `settings.json`:

```json
"gcode.appearance.tokens": {
	"dark": { "--glass-base": "#101826", "--warn": "#ff9f43" },
	"light": { "--glass-base": "#f4f1ea" }
}
```

The panel applies the setting when it loads and again when you change it, without a reload.

- The keys are theme kinds: `dark`, `light`, `highContrast`, and `highContrastLight`. A kind you leave out keeps Geno's own values. High contrast changes only when you name its kind.
- Each kind maps Geno token names, with their leading `--`, to CSS values. The extension checks each name against the tokens that `dist/webview.css` declares.
- The extension ignores an unknown kind, an unknown token, and VS Code's own `--vscode-*` variables. It also ignores a value that holds `;`, `{`, `}`, `<`, `>`, `\`, or `!`, a value that loads a resource such as `url(...)`, and a value with an open bracket or quote. Each one it ignores shows as a warning and as an `appearance:` line in the **Geno engine** output.
- The panel sets each value on every element and marks it important, so it wins over the style's and the components' own values. Tokens that Geno builds from it, such as `--surface` from `--bg`, follow it.

## Update the screenshots

The screenshots on this page come from a running gallery. With `pnpm ui` running, run:

```sh
pnpm exec tsx packages/extension/test/gallery/screenshots.mts http://127.0.0.1:5390/ docs/ui-gallery
```

Add `--groups` to also shoot every group in dark and light, which helps when you review a change across states.

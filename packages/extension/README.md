# Geno

Geno is a coding agent in VS Code: chat, review, Cmd-K and Tab. To build and install it, see `docs/install.md` in the repository.

## Themes

The chat panel follows your VS Code color theme. To change Geno's own colors and sizes on top of it, set `gcode.appearance.tokens` in your user settings. Its keys are theme kinds, and each maps Geno tokens to CSS values:

```json
"gcode.appearance.tokens": {
	"dark": { "--glass-base": "#101826", "--warn": "#ff9f43" },
	"light": { "--glass-base": "#f4f1ea" }
}
```

- The kinds are `dark`, `light`, `highContrast`, and `highContrastLight`. High contrast themes change only when you name their kind.
- Only Geno's tokens apply. Geno ignores an unknown token, VS Code's `--vscode-*` variables, and a value that could load a resource or end the declaration, and it warns about each one.
- The panel applies a change without a reload.

To make a theme, run `pnpm ui` in the repository, change tokens in the gallery's token panel, and click **Export**. The exported file holds the setting's value. `docs/ui-gallery.md` in the repository explains the gallery.

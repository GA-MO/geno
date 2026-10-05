# U8 brief: images and file attachments

The user wants to send images and files to Geno, and to see images in the chat, the way they can in a Claude chat. A live probe on 2026-10-05 showed that Model Studio's `qwen3.8-flash`, `qwen3.6-flash` and `qwen3.7-plus` all read a base64 PNG sent as an Anthropic `image` block. `qwen3.8-flash` also reads an image returned inside a `tool_result`. Qwen cannot generate images, so Geno shows images; it does not draw them.

## User to Geno

- Attach images by pasting (Cmd+V), by dragging into the composer (from Finder and from the VS Code explorer), and through the composer's `+` menu. That menu gets "Attach file…" next to the existing `@` mentions and opens a native file picker.
- Each attachment shows as a chip with a thumbnail, a name, a size and a remove button.
  - The webview downscales images so the long side is at most 1568 px. It re-encodes large photos as JPEG and keeps PNG for screenshots and line art.
  - The limits are 8 images and 5 MB per message after downscaling. Going over shows a clear message.
- A text or code file attaches as its content, the same as `@file`, with its path. A binary file that is not an image is refused with a clear message. PDF is out of scope for now.
- On the wire, the extension sends images as ACP `image` content blocks and files as embedded `resource` blocks in `session/prompt`. The engine turns them into Anthropic `image` and text blocks in the user message.
- Storage: the engine writes each image once to `$GCODE_HOME/sessions/<id>/attachments/<sha256>.<ext>`. The session log records only the reference: hash, media type, name and size. `replayMessages` loads the bytes back, so a resumed or loaded session sends the same image. The cache prefix stays byte-stable.

## Geno to the user

- The `read` tool, given a png, jpg, gif or webp file in the workspace up to the size limit, returns the image to the model in the `tool_result` and to the editor as a thumbnail on the step. Every other file type behaves as today.
- Markdown images in assistant text that point at a workspace file render inline, through the webview resource URI scoped to the workspace folders. Remote or out-of-workspace image URLs never load. They show as a link with a note instead, which keeps the strict CSP and avoids tracking pixels.
- Clicking any thumbnail or inline image opens the file in a VS Code editor tab. A pasted attachment opens from the session's attachments folder.
- Style: the dark and light glass of `docs/u7.md`. Thumbnails have rounded glass frames, and nothing else on the page gets new color.

## Data shape first

Name these before writing code:
- an `Attachment` record (kind `image` or `file`, hash, media type, name, byte size, and pixel size for images);
- its place in the `user` turn event;
- the rule that turns a stored reference back into a content block;
- the webview's attachment states (reading, ready, rejected with a reason).

## Verify

- Unit tests:
  - downscale sizing math;
  - the hash-addressed store writes each image once, and a rerun is a no-op;
  - `replayMessages` with attachments;
  - the `read` tool returning an image block for a small PNG and text for a `.ts` file;
  - limit and refusal messages.
- Integration tests in VS Code (test workspaces keep `chat.disableAIFeatures: true` and the hidden secondary sidebar):
  - paste an image, through a synthetic paste event carrying a `DataTransfer` file in the webview;
  - drop a file from the explorer, through a synthetic drop with a `text/uri-list`;
  - the chips render and can be removed;
  - the fake model receives an `image` block;
  - a `read` of a workspace PNG shows a thumbnail on the step;
  - a markdown image of a workspace file renders, and a remote one does not load.
- A live smoke on `qwen3.8-flash` under $0.02:
  - attach a generated image with a known answer (two colors, left and right) and assert the answer names them;
  - ask the agent to look at a PNG in the workspace and describe it.
- CDP screenshots in dark glass, light glass and high contrast, saved to `docs/media/u8/`: the composer with image and file chips, a turn with an image the user sent, and a step with a thumbnail from `read`. View each one.
- `pnpm typecheck && pnpm test && pnpm build`, then package the `.vsix` and run the clean-install test, also with `GCODE_VSCODE_VERSION=1.109.2`.

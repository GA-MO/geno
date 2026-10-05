import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';

/** A port nothing listens on right now, for VS Code's --remote-debugging-port. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

type Target = { readonly type: string; readonly url: string; readonly webSocketDebuggerUrl: string };

/**
 * Captures the VS Code window through the Chrome DevTools Protocol on `port`. macOS screen capture needs a
 * permission a test cannot grant; the workbench page can paint itself.
 */
export async function captureWindow(port: number, file: string): Promise<void> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (page === undefined) throw new Error(`no workbench page among ${targets.map((t) => t.url).join(', ')}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const data = await new Promise<string>((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: { data: string }; error?: { message: string } };
        if (message.id !== 1) return;
        if (message.result === undefined) reject(new Error(message.error?.message ?? 'no screenshot'));
        else resolve(message.result.data);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    await writeFile(file, Buffer.from(data, 'base64'));
  } finally {
    socket.close();
  }
}

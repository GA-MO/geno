/**
 * Runs checks that only mean something on macOS. Elsewhere, such as the Linux container the vscode tests run in by
 * default, it says what it skipped and why, so a skip is never silent.
 */
export async function onMac(reason: string, run: () => Promise<void>): Promise<void> {
  if (process.platform === 'darwin') return run();
  console.log(`[mac-only] skipped on ${process.platform}: ${reason}`);
}

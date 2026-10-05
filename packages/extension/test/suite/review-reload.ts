import * as vscode from 'vscode';

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A second window on the same workspace: the inline edit left pending by the first comes back under review. */
export async function run(): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'c.ts');
  await vscode.window.showTextDocument(uri);
  const titles = async () =>
    (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri))
      .filter((lens) => lens.command?.command.startsWith('gcode.review.'))
      .map((lens) => `${lens.range.start.line} ${lens.command!.title}`)
      .sort()
      .join();
  await waitFor('the restored hunk controls on c.ts', async () => (await titles()) === '1 Keep,1 Undo');
  const [keep] = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)).filter(
    (lens) => lens.command?.title === 'Keep',
  );
  await vscode.commands.executeCommand(keep!.command!.command, ...keep!.command!.arguments!);
  await waitFor('the kept hunk to lose its controls', async () => (await titles()) === '');
}

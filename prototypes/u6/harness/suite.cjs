const vscode = require('vscode');

const host = process.env.U6_HOST;
const directions = JSON.parse(process.env.U6_DIRECTIONS);
const states = JSON.parse(process.env.U6_STATES);
const themes = JSON.parse(process.env.U6_THEMES);
const labels = { dark: 'Default Dark Modern', light: 'Default Light Modern', hc: 'Default High Contrast' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(body) {
  const response = await fetch(`${host}/shot`, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`shot failed: ${await response.text()}`);
}

exports.run = async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('u6.proto.focus');
  await pause(500);
  await shot({ width: 560 });
  for (const theme of themes) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', labels[theme], vscode.ConfigurationTarget.Global);
    await pause(800);
    for (const direction of directions) {
      for (const state of states) {
        await vscode.commands.executeCommand('u6.show', direction, state);
        await pause(1500);
        await shot({ direction, state, theme });
      }
    }
  }
};

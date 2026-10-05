const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

/** Shows prototypes/u6/<direction>/index.html in a sidebar webview, with the page's state injected. */
exports.activate = (context) => {
  const protoRoot = path.resolve(context.extensionPath, '..');
  const codicons = path.resolve(protoRoot, '../../packages/extension/node_modules/@vscode/codicons/dist');
  let resolveView;
  const ready = new Promise((resolve) => (resolveView = resolve));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'u6.proto',
      {
        resolveWebviewView(view) {
          view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(protoRoot), vscode.Uri.file(codicons)] };
          resolveView(view);
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('u6.show', async (direction, state) => {
      await vscode.commands.executeCommand('u6.proto.focus');
      const view = await ready;
      const dir = path.join(protoRoot, direction);
      const uri = (p) => view.webview.asWebviewUri(vscode.Uri.file(p)).toString();
      const head = `<head><base href="${uri(dir)}/"><link rel="stylesheet" href="${uri(path.join(codicons, 'codicon.css'))}"><script>window.PROTO_STATE = ${JSON.stringify(state)};</script>`;
      view.webview.html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('<head>', head);
    }),
  );
};

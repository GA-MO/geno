import type * as vscode from 'vscode';

// Only real files: a bare pattern also matches VS Code's own text inputs, such as the chat box.
export const TAB_DOCUMENTS: vscode.DocumentSelector = [{ scheme: 'file' }, { scheme: 'untitled' }];

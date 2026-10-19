import * as vscode from 'vscode';

/** "AI Skills" output channel: what each action did or why it stopped. Never logs tokens or file contents. */
let channel: vscode.LogOutputChannel | undefined;

export function log(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('AI Skills', { log: true });
  return channel;
}

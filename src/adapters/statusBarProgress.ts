import * as vscode from 'vscode';
import { Progress } from '../core/ports';

/** Shows the stage of the running operation in the status bar. */
export class StatusBarProgress implements Progress, vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor(command: string) {
		this.item = vscode.window.createStatusBarItem('branchReviewer.status', vscode.StatusBarAlignment.Left, 0);
		this.item.name = 'Branch Reviewer';
		this.item.command = command;
		this.item.tooltip = 'Branch Reviewer: show log';
	}

	busy(text: string): void {
		this.item.text = `$(sync~spin) Branch Reviewer: ${text}`;
		this.item.show();
	}

	rest(text: string | undefined): void {
		if (text === undefined) {
			this.item.hide();
			return;
		}
		this.item.text = `$(git-commit) Branch Reviewer: ${text}`;
		this.item.show();
	}

	dispose(): void {
		this.item.dispose();
	}
}

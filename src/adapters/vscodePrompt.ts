import * as vscode from 'vscode';
import { DirtyChoice, Prompt } from '../core/ports';

const AUTOSTASH = 'Autostash';
const CANCEL = 'Cancel';

export class VsCodePrompt implements Prompt {
	info(message: string): void {
		void vscode.window.showInformationMessage(message);
	}

	warn(message: string): void {
		void vscode.window.showWarningMessage(message);
	}

	error(message: string): void {
		void vscode.window.showErrorMessage(message);
	}

	async chooseDirtyAction(action: string): Promise<DirtyChoice> {
		const choice = await vscode.window.showWarningMessage(
			`The working tree has uncommitted changes. Autostash them to ${action}? They are restored when the review ends.`,
			AUTOSTASH,
			CANCEL,
		);
		return choice === AUTOSTASH ? 'autostash' : 'cancel';
	}
}

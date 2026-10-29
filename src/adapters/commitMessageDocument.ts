import * as vscode from 'vscode';
import { Logger, MessageDocument } from '../core/ports';

const GIT_COMMIT_LANGUAGE = 'git-commit';

/**
 * The reviewed commit's message, materialized as `COMMIT_EDITMSG` inside
 * the git directory. That name is what VS Code's git support associates
 * with the git-commit language, and keeping it out of the working tree
 * means editing it never makes the tree dirty.
 */
export class CommitMessageDocument implements MessageDocument {
	constructor(readonly uri: vscode.Uri, private readonly logger: Logger) {}

	async show(message: string): Promise<void> {
		let document = this.openDocument();
		if (document) {
			// Writing underneath an open buffer would make its next save conflict
			// with the disk, so an open buffer is edited and saved instead.
			if (document.getText() !== message) {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(this.uri, new vscode.Range(0, 0, document.lineCount, 0), message);
				await vscode.workspace.applyEdit(edit);
				await document.save();
			}
		} else {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.uri, '..'));
			await vscode.workspace.fs.writeFile(this.uri, Buffer.from(message, 'utf8'));
			document = await vscode.workspace.openTextDocument(this.uri);
		}
		if (document.languageId !== GIT_COMMIT_LANGUAGE) {
			try {
				document = await vscode.languages.setTextDocumentLanguage(document, GIT_COMMIT_LANGUAGE);
			} catch (error) {
				this.logger.debug(`git-commit language unavailable: ${String(error)}`);
			}
		}
		await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
	}

	async read(): Promise<string> {
		const open = this.openDocument();
		if (open) {
			if (open.isDirty) {
				await open.save();
			}
			return open.getText();
		}
		return Buffer.from(await vscode.workspace.fs.readFile(this.uri)).toString('utf8');
	}

	private openDocument(): vscode.TextDocument | undefined {
		return vscode.workspace.textDocuments.find(document => document.uri.toString() === this.uri.toString());
	}

	async close(): Promise<void> {
		// Closing a dirty tab asks whether to save, which would stall an abort.
		const open = this.openDocument();
		if (open?.isDirty) {
			await open.save();
		}
		const tabs = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === this.uri.toString());
		if (tabs.length > 0) {
			await vscode.window.tabGroups.close(tabs);
		}
	}
}

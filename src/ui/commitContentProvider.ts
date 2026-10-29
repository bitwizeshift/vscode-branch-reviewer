import * as vscode from 'vscode';
import { CommitInspector } from '../core/git/interfaces';

/** Serves file contents at a revision for diffs and deleted files. */
export class CommitContentProvider implements vscode.TextDocumentContentProvider {
	static readonly scheme = 'branch-reviewer';

	constructor(private readonly inspector: CommitInspector) {}

	static uri(rev: string, file: string): vscode.Uri {
		return vscode.Uri.from({ scheme: CommitContentProvider.scheme, path: `/${file}`, query: rev });
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		return (await this.inspector.show(uri.query, uri.path.slice(1))) ?? '';
	}
}

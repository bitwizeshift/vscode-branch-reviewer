import * as vscode from 'vscode';
import { CommitChanges } from '../core/files/commitChanges';
import { ChangeKind } from '../core/git/types';
import { relativePath, REVIEW_QUERY } from './repositoryPaths';

const STYLES: Readonly<Record<ChangeKind, { badge: string; tooltip: string; color: string }>> = {
	added: { badge: 'A', tooltip: 'Added in this commit', color: 'branchReviewer.addedForeground' },
	modified: { badge: 'M', tooltip: 'Modified in this commit', color: 'branchReviewer.modifiedForeground' },
	deleted: { badge: 'D', tooltip: 'Deleted in this commit', color: 'branchReviewer.deletedForeground' },
	renamed: { badge: 'R', tooltip: 'Renamed in this commit', color: 'branchReviewer.renamedForeground' },
};

/** Colors entries of the Files Changed view by what the commit did to them. */
export class ChangeDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<undefined>();
	private readonly subscription: vscode.Disposable;
	readonly onDidChangeFileDecorations = this.emitter.event;

	constructor(private readonly changes: CommitChanges, private readonly root: vscode.Uri) {
		this.subscription = changes.onDidChange(() => this.emitter.fire(undefined));
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.query !== REVIEW_QUERY) {
			return undefined;
		}
		const path = relativePath(this.root, uri);
		const kind = path === undefined ? undefined : this.changes.index.kindOf(path);
		if (!path || !kind) {
			return undefined;
		}
		const style = STYLES[kind];
		const badge = this.changes.index.isChangedFile(path) ? style.badge : undefined;
		return new vscode.FileDecoration(badge, style.tooltip, new vscode.ThemeColor(style.color));
	}

	dispose(): void {
		this.subscription.dispose();
		this.emitter.dispose();
	}
}

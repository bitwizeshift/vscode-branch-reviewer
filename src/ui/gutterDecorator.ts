import * as vscode from 'vscode';
import { parseLineChanges, LineChanges, LineRange } from '../core/diff/hunks';
import { CommitChanges } from '../core/files/commitChanges';
import { CommitInspector } from '../core/git/interfaces';
import { Logger } from '../core/ports';
import { relativePath } from './repositoryPaths';

const NONE: LineChanges = { added: [], modified: [], deleted: [] };

/** Marks the lines the commit under review changed in open editors. */
export class GutterDecorator implements vscode.Disposable {
	private readonly added: vscode.TextEditorDecorationType;
	private readonly modified: vscode.TextEditorDecorationType;
	private readonly deleted: vscode.TextEditorDecorationType;
	private readonly cache = new Map<string, Promise<LineChanges>>();
	private readonly subscriptions: vscode.Disposable[];

	constructor(
		private readonly changes: CommitChanges,
		private readonly inspector: CommitInspector,
		private readonly root: vscode.Uri,
		media: vscode.Uri,
		private readonly logger: Logger,
	) {
		const type = (icon: string, color: string) => vscode.window.createTextEditorDecorationType({
			gutterIconPath: vscode.Uri.joinPath(media, icon),
			gutterIconSize: 'contain',
			overviewRulerColor: new vscode.ThemeColor(color),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
			isWholeLine: true,
		});
		this.added = type('gutter-added.svg', 'branchReviewer.addedForeground');
		this.modified = type('gutter-modified.svg', 'branchReviewer.modifiedForeground');
		this.deleted = type('gutter-deleted.svg', 'branchReviewer.deletedForeground');
		this.subscriptions = [
			this.added, this.modified, this.deleted,
			changes.onDidChange(() => {
				this.cache.clear();
				void this.update(vscode.window.visibleTextEditors);
			}),
			vscode.window.onDidChangeVisibleTextEditors(editors => void this.update(editors)),
		];
		void this.update(vscode.window.visibleTextEditors);
	}

	private async update(editors: readonly vscode.TextEditor[]): Promise<void> {
		await Promise.all(editors.map(async editor => this.apply(editor, await this.lineChanges(editor.document.uri))));
	}

	private async lineChanges(uri: vscode.Uri): Promise<LineChanges> {
		const rev = this.changes.rev;
		const path = relativePath(this.root, uri);
		if (!rev || !path || !this.changes.index.isChangedFile(path)) {
			return NONE;
		}
		const key = `${rev}\0${path}`;
		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.inspector.patch(rev, path).then(parseLineChanges, error => {
				this.logger.error(`Reading the patch of ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
				return NONE;
			});
			this.cache.set(key, pending);
		}
		return pending;
	}

	private apply(editor: vscode.TextEditor, changes: LineChanges): void {
		const ranges = (lines: readonly LineRange[]) => lines.map(line => new vscode.Range(line.start, 0, line.end, 0));
		editor.setDecorations(this.added, ranges(changes.added));
		editor.setDecorations(this.modified, ranges(changes.modified));
		editor.setDecorations(this.deleted, changes.deleted.map(line => new vscode.Range(line, 0, line, 0)));
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}
}

import * as vscode from 'vscode';
import { CommitChanges } from '../core/files/commitChanges';
import { childNodes, DirectoryEntry, TreeNode } from '../core/files/fileTreeModel';
import { CommitContentProvider } from './commitContentProvider';
import { REVIEW_QUERY } from './repositoryPaths';

export type FilesItem = { readonly kind: 'message' } | { readonly kind: 'node'; readonly node: TreeNode };

/**
 * An Explorer-like tree of the working tree at the commit under review,
 * headed by the editable commit message.
 */
export class FilesTreeProvider implements vscode.TreeDataProvider<FilesItem>, vscode.Disposable {
	static readonly viewId = 'branchReviewer.files';

	private changedOnly = false;
	private readonly emitter = new vscode.EventEmitter<FilesItem | undefined>();
	private readonly subscription: vscode.Disposable;
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly changes: CommitChanges, private readonly root: vscode.Uri, private readonly messageUri: vscode.Uri) {
		this.subscription = changes.onDidChange(() => this.emitter.fire(undefined));
	}

	get filtering(): boolean {
		return this.changedOnly;
	}

	setChangedOnly(value: boolean): void {
		this.changedOnly = value;
		this.emitter.fire(undefined);
	}

	async getChildren(element?: FilesItem): Promise<FilesItem[]> {
		if (this.changes.rev === undefined) {
			return [];
		}
		if (!element) {
			return [{ kind: 'message' }, ...await this.nodes('')];
		}
		return element.kind === 'node' && element.node.directory ? this.nodes(element.node.path) : [];
	}

	getTreeItem(element: FilesItem): vscode.TreeItem {
		if (element.kind === 'message') {
			const item = new vscode.TreeItem('Commit Message', vscode.TreeItemCollapsibleState.None);
			item.id = 'branchReviewer.message';
			item.iconPath = new vscode.ThemeIcon('git-commit');
			item.tooltip = 'Edit the message of the commit under review';
			item.command = { command: 'vscode.open', title: 'Open Commit Message', arguments: [this.messageUri] };
			return item;
		}
		const { node } = element;
		const fileUri = vscode.Uri.joinPath(this.root, node.path);
		const state = !node.directory
			? vscode.TreeItemCollapsibleState.None
			: this.changedOnly ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
		const item = new vscode.TreeItem(fileUri.with({ query: REVIEW_QUERY }), state);
		item.id = `${this.changedOnly ? 'changed' : 'all'}:${node.path}`;
		item.contextValue = node.directory ? 'folder' : node.change ? 'changedFile' : 'file';
		if (!node.directory) {
			const target = node.deleted && this.changes.rev
				? CommitContentProvider.uri(`${this.changes.rev}^`, node.path)
				: fileUri;
			item.command = { command: 'vscode.open', title: 'Open File', arguments: [target] };
		}
		if (node.deleted) {
			item.description = 'deleted';
		}
		return item;
	}

	private async nodes(directory: string): Promise<FilesItem[]> {
		let entries: DirectoryEntry[] = [];
		try {
			const listing = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(this.root, directory));
			entries = listing.map(([name, type]) => ({ name, directory: (type & vscode.FileType.Directory) !== 0 }));
		} catch {
			// Folders that only exist in the parent commit have no listing.
		}
		return childNodes(directory, entries, this.changes.index, this.changedOnly).map(node => ({ kind: 'node', node }));
	}

	dispose(): void {
		this.subscription.dispose();
		this.emitter.dispose();
	}
}

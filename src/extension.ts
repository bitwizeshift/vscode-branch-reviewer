import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CommitMessageDocument } from './adapters/commitMessageDocument';
import { GitDirWatcher } from './adapters/gitDirWatcher';
import { MementoStore } from './adapters/mementoStore';
import { NodeGitRunner } from './adapters/nodeGitRunner';
import { NodeTextFiles } from './adapters/nodeTextFiles';
import { OutputLogger } from './adapters/outputLogger';
import { StatusBarProgress } from './adapters/statusBarProgress';
import { VsCodePrompt } from './adapters/vscodePrompt';
import { CommitChanges } from './core/files/commitChanges';
import { discoverPaths, GitInspector, GitRepository } from './core/git/gitRepository';
import { Logger } from './core/ports';
import { ReviewController } from './core/review/reviewController';
import { Review } from './core/review/reviewState';
import { ChangeDecorations } from './ui/changeDecorations';
import { CommitContentProvider } from './ui/commitContentProvider';
import { FilesItem, FilesTreeProvider } from './ui/filesTreeProvider';
import { GutterDecorator } from './ui/gutterDecorator';
import { ReviewViewProvider } from './ui/reviewViewProvider';

/** Exposed for the integration tests, which drive the same controller as the panel. */
export interface BranchReviewerApi {
	readonly controller: ReviewController;
	readonly changes: CommitChanges;
}

const setContext = (key: string, value: unknown) => vscode.commands.executeCommand('setContext', key, value);

export async function activate(context: vscode.ExtensionContext): Promise<BranchReviewerApi | undefined> {
	const channel = vscode.window.createOutputChannel('Branch Reviewer', { log: true });
	const logger = new OutputLogger(channel);
	context.subscriptions.push(channel, vscode.commands.registerCommand('branchReviewer.showLog', () => channel.show()));

	const folder = vscode.workspace.workspaceFolders?.[0];
	const runnerAt = (cwd: string) => new NodeGitRunner(spawn, cwd, process.env, logger);
	const paths = folder && await discoverPaths(runnerAt(folder.uri.fsPath)).catch(error => {
		logger.warn(`No git repository in ${folder.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	});
	if (!paths) {
		await setContext('branchReviewer.noRepository', true);
		return undefined;
	}
	logger.info(`Using repository ${paths.root}.`);
	return wire(context, logger, paths, runnerAt(paths.root));
}

async function wire(
	context: vscode.ExtensionContext,
	logger: Logger,
	paths: Awaited<ReturnType<typeof discoverPaths>>,
	runner: NodeGitRunner,
): Promise<BranchReviewerApi> {
	const root = vscode.Uri.file(paths.root);
	const media = vscode.Uri.joinPath(context.extensionUri, 'media');
	const git = new GitRepository(runner, new NodeTextFiles(), paths);
	const inspector = new GitInspector(runner);
	const message = new CommitMessageDocument(vscode.Uri.file(path.join(paths.reviewerDir, 'COMMIT_EDITMSG')), logger);
	const progress = new StatusBarProgress('branchReviewer.showLog');
	const store = new MementoStore<Review>(context.workspaceState, `branchReviewer.review:${paths.gitDir}`);
	const controller = new ReviewController({ git, message, prompt: new VsCodePrompt(), progress, logger, store });
	const changes = new CommitChanges(controller, inspector, logger);

	const reviewView = new ReviewViewProvider(controller, context.extensionUri, logger);
	const files = new FilesTreeProvider(changes, root, message.uri);
	const filesView = vscode.window.createTreeView(FilesTreeProvider.viewId, { treeDataProvider: files, showCollapseAll: true });
	const watcher = new GitDirWatcher(paths.gitDir, () => {
		void controller.checkRepository();
		void reviewView.refreshBranches();
		if (controller.review?.phase === 'paused') {
			void changes.refresh();
		}
	});

	const setChangedOnly = (value: boolean) => {
		files.setChangedOnly(value);
		void setContext('branchReviewer.changedOnly', value);
	};

	context.subscriptions.push(
		progress, reviewView, files, filesView, watcher, changes,
		vscode.window.registerWebviewViewProvider(ReviewViewProvider.viewId, reviewView),
		vscode.window.registerFileDecorationProvider(new ChangeDecorations(changes, root)),
		vscode.workspace.registerTextDocumentContentProvider(CommitContentProvider.scheme, new CommitContentProvider(inspector)),
		new GutterDecorator(changes, inspector, root, media, logger),
		controller.onDidChange(() => void setContext('branchReviewer.reviewing', controller.review !== undefined)),
		vscode.commands.registerCommand('branchReviewer.refresh', async () => {
			await controller.refresh();
			await Promise.all([changes.refresh(), reviewView.refreshBranches()]);
		}),
		vscode.commands.registerCommand('branchReviewer.abort', () => controller.abort()),
		vscode.commands.registerCommand('branchReviewer.files.showChangedOnly', () => setChangedOnly(true)),
		vscode.commands.registerCommand('branchReviewer.files.showAll', () => setChangedOnly(false)),
		vscode.commands.registerCommand('branchReviewer.openChanges', (item: FilesItem) => openChanges(item, changes.rev, root)),
	);

	await setContext('branchReviewer.changedOnly', false);
	await controller.restore();
	await setContext('branchReviewer.reviewing', controller.review !== undefined);
	return { controller, changes };
}

async function openChanges(item: FilesItem | undefined, rev: string | undefined, root: vscode.Uri): Promise<void> {
	if (item?.kind !== 'node' || !rev) {
		return;
	}
	const { node } = item;
	const left = CommitContentProvider.uri(`${rev}^`, node.path);
	const right = node.deleted ? CommitContentProvider.uri(rev, node.path) : vscode.Uri.joinPath(root, node.path);
	await vscode.commands.executeCommand('vscode.diff', left, right, `${node.name} (${rev.slice(0, 7)})`);
}

export function deactivate() {}

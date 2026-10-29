import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BranchReviewerApi } from '../../extension';

export const root = process.env.BRANCH_REVIEWER_FIXTURE ?? '';

export function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
}

export function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), text);
}

export function commit(subject: string, files: Record<string, string>): string {
	for (const [file, text] of Object.entries(files)) {
		write(file, text);
	}
	git('add', '--all');
	git('commit', '--quiet', '--message', subject);
	return git('rev-parse', 'HEAD');
}

export async function api(): Promise<BranchReviewerApi> {
	const extension = vscode.extensions.getExtension<BranchReviewerApi>('bitwizeshift.branch-reviewer');
	if (!extension) {
		throw new Error('branch-reviewer is not installed in the test host');
	}
	const exports = await extension.activate();
	if (!exports) {
		throw new Error('branch-reviewer did not find the fixture repository');
	}
	return exports;
}

/** Returns the repository to `main` at the root commit with no review. */
export async function reset(reviewer: BranchReviewerApi): Promise<void> {
	await reviewer.controller.abort();
	if (fs.existsSync(path.join(root, '.git', 'rebase-merge'))) {
		git('rebase', '--abort');
	}
	git('checkout', '--quiet', '--force', 'main');
	git('reset', '--quiet', '--hard', git('rev-list', '--max-parents=0', 'HEAD'));
	git('clean', '--quiet', '-fdx');
	for (const branch of git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')) {
		if (branch && branch !== 'main') {
			git('branch', '--quiet', '-D', branch);
		}
	}
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Resolves once `predicate` holds after a controller change, failing after `ms`. */
export function until(reviewer: BranchReviewerApi, predicate: () => boolean, ms = 5000): Promise<void> {
	if (predicate()) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			subscription.dispose();
			reject(new Error('Timed out waiting for the review to change'));
		}, ms);
		const subscription = reviewer.controller.onDidChange(() => {
			if (predicate()) {
				clearTimeout(timer);
				subscription.dispose();
				resolve();
			}
		});
	});
}

/** Replaces the text of the open commit message editor without saving. */
export async function editMessage(text: string): Promise<void> {
	const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath.endsWith(path.join('branch-reviewer', 'COMMIT_EDITMSG')));
	if (!document) {
		throw new Error('The commit message is not open');
	}
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
	await vscode.workspace.applyEdit(edit);
}

import * as vscode from 'vscode';

/** Files whose changes can mean the repository moved underneath a review. */
const PATTERN = '{HEAD,ORIG_HEAD,packed-refs,rebase-merge/**,rebase-apply/**,refs/heads/**}';

/**
 * Reports changes inside the git directory. Bursts of events, such as a
 * rebase rewriting many files, are coalesced into one notification once
 * the directory has been quiet for `delay` milliseconds.
 */
export class GitDirWatcher implements vscode.Disposable {
	private readonly watcher: vscode.FileSystemWatcher;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(gitDir: string, private readonly onChange: () => void, private readonly delay = 200) {
		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(gitDir), PATTERN));
		const schedule = () => this.schedule();
		this.watcher.onDidChange(schedule);
		this.watcher.onDidCreate(schedule);
		this.watcher.onDidDelete(schedule);
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.onChange();
		}, this.delay);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.watcher.dispose();
	}
}

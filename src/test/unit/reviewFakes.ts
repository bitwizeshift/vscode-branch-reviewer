import { ProgressListener, ReviewGit } from '../../core/git/interfaces';
import { Commit, DefaultBranchHints, RebaseOutcome, RepositorySnapshot, WorkingTreeStatus } from '../../core/git/types';
import { DirtyChoice, MessageDocument, Progress, Prompt, StateStore } from '../../core/ports';
import { Review } from '../../core/review/reviewState';

export const clean: WorkingTreeStatus = { unmerged: [], staged: [], unstaged: [] };

/**
 * Hand-rolled ReviewGit mock. Each method records a call and answers from
 * a field that tests overwrite; queues let a test script successive results.
 */
export class MockGit implements ReviewGit {
	readonly calls: string[] = [];
	branchList = ['main', 'topic'];
	current: string | undefined = 'topic';
	hints: DefaultBranchHints = {};
	refs: Record<string, string> = { 'refs/heads/main': 'b0', 'refs/heads/topic': 'c2' };
	ancestor = true;
	merges = false;
	commitQueue: Commit[][] = [];
	snapshotValue: RepositorySnapshot = { rebasing: false, attached: true, baseSha: 'b0' };
	snapshotError: Error | undefined;
	messages: Record<string, string> = { HEAD: 'One\n' };
	startOutcome: RebaseOutcome = 'stopped';
	continueQueue: RebaseOutcome[] = [];
	amendedSha = 'a1';
	treeQueue: WorkingTreeStatus[] = [];
	stashSha = 's1';
	stashRestores = true;
	abortError: Error | undefined;
	fastForwardError: Error | undefined;
	progressToReport: { current: number; total: number } | undefined;

	async branches() { return this.branchList; }
	async currentBranch() { return this.current; }
	async defaultBranchHints() { return this.hints; }
	async resolve(ref: string) { return this.refs[ref]; }
	async isAncestor() { return this.ancestor; }
	async hasMerges() { return this.merges; }

	async commits(base: string, head: string) {
		this.calls.push(`commits ${base}..${head}`);
		return this.commitQueue.shift() ?? [];
	}

	async snapshot() {
		if (this.snapshotError) {
			throw this.snapshotError;
		}
		return this.snapshotValue;
	}

	async message(rev: string) { return this.messages[rev] ?? ''; }

	async normalizeMessage(text: string) {
		return text.split('\n').filter(line => !line.startsWith('#')).join('\n').trim() + '\n';
	}

	async startRebase(base: string, head: string, todo: string, onProgress: ProgressListener) {
		this.calls.push(`start ${base} ${head} ${todo.trim().replace(/\n/g, ' | ')}`);
		this.emitProgress(onProgress);
		return this.startOutcome;
	}

	async rewriteTodo(todo: string) {
		this.calls.push(`todo ${todo.trim().replace(/\n/g, ' | ')}`);
	}

	async continueRebase(onProgress: ProgressListener) {
		this.calls.push('continue');
		this.emitProgress(onProgress);
		return this.continueQueue.shift() ?? 'finished';
	}

	async abortRebase() {
		this.calls.push('abort');
		if (this.abortError) {
			throw this.abortError;
		}
	}

	async amend(message: string) {
		this.calls.push(`amend ${message.trim()}`);
		return this.amendedSha;
	}

	async fastForward(branch: string, to: string, from: string) {
		this.calls.push(`ff ${branch} ${from}->${to}`);
		if (this.fastForwardError) {
			throw this.fastForwardError;
		}
	}

	async workingTree() { return this.treeQueue.shift() ?? clean; }

	async stash() {
		this.calls.push('stash');
		return this.stashSha;
	}

	async restoreStash(sha: string) {
		this.calls.push(`pop ${sha}`);
		return this.stashRestores;
	}

	private emitProgress(onProgress: ProgressListener) {
		if (this.progressToReport) {
			onProgress(this.progressToReport);
		}
	}
}

export class MockMessage implements MessageDocument {
	shown: string[] = [];
	closed = 0;
	text = 'One\n';
	closeError: Error | undefined;

	async show(message: string) { this.shown.push(message); }
	async read() { return this.text; }

	async close() {
		this.closed++;
		if (this.closeError) {
			throw this.closeError;
		}
	}
}

export class MockPrompt implements Prompt {
	readonly messages: string[] = [];
	choice: DirtyChoice = 'cancel';
	asked: string[] = [];

	info(message: string) { this.messages.push(`info: ${message}`); }
	warn(message: string) { this.messages.push(`warn: ${message}`); }
	error(message: string) { this.messages.push(`error: ${message}`); }

	async chooseDirtyAction(action: string) {
		this.asked.push(action);
		return this.choice;
	}
}

export class MockProgress implements Progress {
	readonly updates: string[] = [];
	resting: string | undefined;

	busy(text: string) { this.updates.push(text); }
	rest(text: string | undefined) { this.resting = text; }
}

export class MemoryStore implements StateStore<Review> {
	value: Review | undefined;
	saves = 0;

	load() { return this.value; }

	async save(value: Review | undefined) {
		this.saves++;
		this.value = value;
	}
}

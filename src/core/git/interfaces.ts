import {
	ChangedFile,
	Commit,
	DefaultBranchHints,
	RebaseOutcome,
	RebaseProgress,
	RepositorySnapshot,
	WorkingTreeStatus,
} from './types';

export type ProgressListener = (progress: RebaseProgress) => void;

/** Repository operations the review workflow drives. */
export interface ReviewGit {
	branches(): Promise<string[]>;
	currentBranch(): Promise<string | undefined>;
	defaultBranchHints(): Promise<DefaultBranchHints>;
	resolve(ref: string): Promise<string | undefined>;
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
	commits(base: string, head: string): Promise<Commit[]>;
	hasMerges(base: string, head: string): Promise<boolean>;
	snapshot(base: string): Promise<RepositorySnapshot>;
	message(rev: string): Promise<string>;
	/** Applies git's own message cleanup so edits can be compared fairly. */
	normalizeMessage(text: string): Promise<string>;
	/** Starts an interactive rebase of `head` onto `base` with `todo`. */
	startRebase(base: string, head: string, todo: string, onProgress: ProgressListener): Promise<RebaseOutcome>;
	/** Replaces the remaining todo of the rebase in progress. */
	rewriteTodo(todo: string): Promise<void>;
	continueRebase(onProgress: ProgressListener): Promise<RebaseOutcome>;
	abortRebase(): Promise<void>;
	/** True when the commit object carries a signature, valid or not. */
	isSigned(rev: string): Promise<boolean>;
	/** Re-creates HEAD as a signed commit with `message` and returns its id. */
	amend(message: string): Promise<string>;
	/** Moves `branch` from `from` to `to`, failing if it no longer points at `from`. */
	fastForward(branch: string, to: string, from: string): Promise<void>;
	workingTree(): Promise<WorkingTreeStatus>;
	/** Stashes tracked changes and returns the stash commit id. */
	stash(): Promise<string>;
	/** Pops the stash entry `sha`; false when it is gone or did not apply cleanly. */
	restoreStash(sha: string): Promise<boolean>;
}

/** Read-only views of a single commit, used by the editor integrations. */
export interface CommitInspector {
	changedFiles(sha: string): Promise<ChangedFile[]>;
	parent(sha: string): Promise<string | undefined>;
	show(rev: string, path: string): Promise<string | undefined>;
	/** Zero-context patch of `path` as changed by `sha`. */
	patch(sha: string, path: string): Promise<string>;
}

export interface Commit {
	readonly sha: string;
	readonly subject: string;
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
	readonly path: string;
	readonly kind: ChangeKind;
	readonly oldPath?: string;
}

export interface WorkingTreeStatus {
	readonly unmerged: readonly string[];
	readonly staged: readonly string[];
	readonly unstaged: readonly string[];
}

export interface RebaseProgress {
	readonly current: number;
	readonly total: number;
}

export type RebaseOutcome = 'finished' | 'stopped' | 'conflict';

export interface RepositorySnapshot {
	readonly rebasing: boolean;
	/** Ref being rebased, e.g. `refs/heads/topic`, when a rebase is underway. */
	readonly rebaseHeadName?: string;
	readonly head?: string;
	/** True when HEAD is a symbolic ref, which never holds mid-rebase. */
	readonly attached: boolean;
	readonly baseSha?: string;
}

export interface DefaultBranchHints {
	readonly originHead?: string;
	readonly initDefault?: string;
}

export class GitError extends Error {
	constructor(readonly args: readonly string[], readonly code: number, readonly stderr: string) {
		super(`git ${args.join(' ')} failed (${code}): ${stderr.trim() || 'no output'}`);
		this.name = 'GitError';
	}
}

import { ProgressListener, ReviewGit } from '../git/interfaces';
import { buildTodo } from '../git/parsers';
import { Commit, GitError, RebaseOutcome } from '../git/types';
import { Disposable, Logger, MessageDocument, Progress, Prompt, StateStore } from '../ports';
import { findInconsistency } from './consistency';
import { defaultBase, defaultHead } from './defaultBranch';
import { FollowUp, Review, ReviewPhase } from './reviewState';

export interface ReviewControllerDependencies {
	readonly git: ReviewGit;
	readonly message: MessageDocument;
	readonly prompt: Prompt;
	readonly progress: Progress;
	readonly logger: Logger;
	readonly store: StateStore<Review>;
}

export interface BranchChoices {
	readonly branches: readonly string[];
	readonly base?: string;
	readonly head?: string;
}

/** An expected failure whose message is meant for the user as-is. */
export class ReviewError extends Error {}

/** Unwinds an action the user declined or that an abort superseded. */
class Cancelled extends Error {}

interface Operation {
	readonly label: string;
	readonly epoch: number;
}

const short = (sha: string) => sha.slice(0, 7);
const firstLine = (text: string) => text.split('\n').find(line => line.trim().length > 0)?.trim() ?? '';

/**
 * Drives a review from start to finish. Every action runs under a single
 * operation at a time; an abort is the exception and always runs, bumping
 * the epoch so that whatever it interrupted can no longer write state.
 */
export class ReviewController {
	private current: Review | undefined;
	private operation: Operation | undefined;
	private epoch = 0;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly deps: ReviewControllerDependencies) {}

	get review(): Review | undefined {
		return this.current;
	}

	/** Label of the running operation, if any. */
	get activity(): string | undefined {
		return this.operation?.label;
	}

	onDidChange(listener: () => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Reloads a review persisted by a previous window and re-validates it. */
	async restore(): Promise<void> {
		this.current = this.deps.store.load();
		if (this.current) {
			this.deps.logger.info(`Restored review of '${this.current.head}' onto '${this.current.base}' (${this.current.phase}).`);
		}
		this.emit();
		await this.checkRepository();
	}

	async branchChoices(): Promise<BranchChoices> {
		const { git } = this.deps;
		const [branches, current, hints] = await Promise.all([git.branches(), git.currentBranch(), git.defaultBranchHints()]);
		const base = defaultBase(branches, hints, current);
		return { branches, base, head: defaultHead(branches, base, current) };
	}

	start(base: string, head: string): Promise<void> {
		return this.run(`Starting review of ${head}`, async op => {
			const { git, logger } = this.deps;
			if (this.current) {
				throw new ReviewError('A review is already in progress.');
			}
			if (base === head) {
				throw new ReviewError('The base and head branches must differ.');
			}
			if ((await git.snapshot(base)).rebasing) {
				throw new ReviewError('A rebase is already in progress in this repository.');
			}
			const baseSha = await git.resolve(`refs/heads/${base}`);
			if (!baseSha || !await git.resolve(`refs/heads/${head}`)) {
				throw new ReviewError(`Both '${base}' and '${head}' must be local branches.`);
			}
			if (!await git.isAncestor(base, head)) {
				throw new ReviewError(`'${head}' must be rebased onto '${base}' before it can be reviewed.`);
			}
			if (await git.hasMerges(base, head)) {
				throw new ReviewError(`'${head}' contains merge commits, which cannot be reviewed one at a time.`);
			}
			const pending = await git.commits(base, head);
			if (pending.length === 0) {
				throw new ReviewError(`'${head}' has no commits beyond '${base}'.`);
			}
			const stashes = await this.ensureClean('start the review', []);
			logger.info(`Starting review of ${pending.length} commit(s) on '${head}' onto '${base}'.`);
			const review: Review = { base, head, baseSha, approved: [], pending, phase: 'active', stashes };
			try {
				await this.startPass(op, review);
			} catch (error) {
				// Nothing has been recorded yet, so undo what the attempt left behind.
				await git.abortRebase().catch(cause => logger.error(`Cleanup abort failed: ${String(cause)}`));
				await this.restoreStashes(stashes);
				throw error;
			}
		});
	}

	approve(): Promise<void> {
		return this.run('Approving commit', async op => {
			const { git, message, logger, progress } = this.deps;
			const review = this.require('active');
			const commit = review.pending[0];
			const edited = await message.read();
			const [draft, original, signed] = await Promise.all([
				git.normalizeMessage(edited),
				git.message('HEAD').then(text => git.normalizeMessage(text)),
				git.isSigned('HEAD'),
			]);
			const stashes = await this.ensureClean('approve the commit', review.stashes);
			const prepared = { ...review, stashes };
			const reworded = draft !== original;
			if (reworded || !signed) {
				// Only signed commits reach the base. Re-creating the commit gives it
				// a new id, so the rest of the branch is replayed onto it, as a
				// forced rebase of that commit would, before the base moves.
				progress.busy(reworded ? 'Amending commit message' : 'Signing commit');
				const sha = await git.amend(edited);
				const change = reworded ? 'Reworded' : 'Signed';
				logger.info(`${change} ${short(commit.sha)} as ${short(sha)}; replaying the rest of '${review.head}'.`);
				await this.replay(op, prepared, { kind: 'approve', sha, subject: firstLine(draft) });
				return;
			}
			progress.busy(`Fast-forwarding ${review.base}`);
			await git.fastForward(review.base, commit.sha, review.baseSha);
			logger.info(`Approved ${short(commit.sha)} '${commit.subject}' onto '${review.base}'.`);
			const next: Review = { ...prepared, baseSha: commit.sha, approved: [...review.approved, commit], pending: review.pending.slice(1) };
			await this.set(op, next);
			if (next.pending.length > 0) {
				await git.rewriteTodo(buildTodo(next.pending, true));
			}
			const outcome = await git.continueRebase(this.reportProgress);
			await this.settle(op, next, outcome, { kind: 'resume' });
		});
	}

	reject(): Promise<void> {
		return this.run('Rejecting commit', async op => this.set(op, { ...this.require('active'), phase: 'rejecting' }));
	}

	cancelReject(): Promise<void> {
		return this.run('Cancelling rejection', async op => this.set(op, { ...this.require('rejecting'), phase: 'active' }));
	}

	edit(): Promise<void> {
		return this.run('Pausing review', async op => {
			const review = this.require('rejecting');
			await this.set(op, { ...review, phase: 'paused' });
			this.deps.logger.info(`Paused at ${short(review.pending[0].sha)} for history edits.`);
			this.deps.prompt.info('The rebase is paused. Amend or add commits, then press Resume.');
		});
	}

	resume(): Promise<void> {
		return this.run('Resuming review', async op => {
			const review = this.require('paused');
			const stashes = await this.ensureClean('resume the review', review.stashes);
			await this.replay(op, { ...review, stashes }, { kind: 'resume' });
		});
	}

	quit(): Promise<void> {
		return this.run('Quitting review', async op => {
			const review = this.require('active', 'rejecting', 'paused');
			const stashes = await this.ensureClean('quit the review', review.stashes);
			await this.replay(op, { ...review, stashes }, { kind: 'quit' });
		});
	}

	continueAfterConflict(): Promise<void> {
		return this.run('Continuing rebase', async op => {
			const review = this.require('conflict');
			const status = await this.deps.git.workingTree();
			if (status.unmerged.length > 0) {
				throw new ReviewError(`Resolve and stage ${status.unmerged.length} conflicted file(s) before continuing.`);
			}
			if (status.unstaged.length > 0) {
				// Stashing here would also capture the staged resolutions.
				throw new ReviewError('Stage or discard the remaining unstaged changes before continuing.');
			}
			await this.replay(op, review, review.followUp ?? { kind: 'resume' });
		});
	}

	/**
	 * Abandons the review with `git rebase --abort`. This never fails: every
	 * step is attempted independently and the state is always cleared.
	 */
	async abort(): Promise<void> {
		this.epoch++;
		const op = this.begin('Aborting review');
		const { git, message, logger, prompt } = this.deps;
		const review = this.current;
		try {
			if (review && await this.ownsRebase(review)) {
				await git.abortRebase();
			}
		} catch (error) {
			logger.error(`git rebase --abort failed: ${describe(error)}`);
			prompt.error(`Aborting the rebase failed; the review was reset anyway. ${describe(error)}`);
		}
		await this.restoreStashes(review?.stashes ?? []);
		await message.close().catch(error => logger.error(`Closing the message editor failed: ${describe(error)}`));
		await this.set(op, undefined).catch(error => logger.error(`Clearing review state failed: ${describe(error)}`));
		this.end(op);
	}

	/**
	 * Only a rebase of the reviewed branch is aborted; after an invalidation
	 * the rebase in progress may be an unrelated one the user started. If
	 * the repository cannot be inspected, aborting is still attempted.
	 */
	private async ownsRebase(review: Review): Promise<boolean> {
		try {
			const snapshot = await this.deps.git.snapshot(review.base);
			return snapshot.rebasing && snapshot.rebaseHeadName === `refs/heads/${review.head}`;
		} catch (error) {
			this.deps.logger.warn(`Could not inspect the repository before aborting: ${describe(error)}`);
			return true;
		}
	}

	dismiss(): Promise<void> {
		return this.run('Dismissing review', async op => {
			const review = this.require('invalidated');
			if (review.stashes.length > 0) {
				this.deps.prompt.warn('Changes autostashed during the review remain in `git stash list`.');
			}
			await this.deps.message.close();
			await this.set(op, undefined);
		});
	}

	refresh(): Promise<void> {
		return this.run('Refreshing', async op => {
			await this.validate(op);
			this.emit();
		});
	}

	/** Re-validates the review after the repository changed on disk. */
	async checkRepository(): Promise<void> {
		if (this.operation || !this.current || this.current.phase === 'invalidated') {
			return;
		}
		await this.run('Checking repository', op => this.validate(op), false);
	}

	private async validate(op: Operation): Promise<void> {
		const review = this.current;
		if (!review) {
			return;
		}
		const reason = findInconsistency(review, await this.deps.git.snapshot(review.base));
		if (reason) {
			this.deps.logger.warn(`Review invalidated: ${reason}`);
			await this.set(op, { ...review, phase: 'invalidated', reason, followUp: undefined });
		}
	}

	/** Replays the remainder of the branch, then performs `followUp`. */
	private async replay(op: Operation, review: Review, followUp: FollowUp): Promise<void> {
		this.deps.progress.busy(`Replaying ${review.head}`);
		let outcome: RebaseOutcome;
		do {
			outcome = await this.deps.git.continueRebase(this.reportProgress);
		} while (outcome === 'stopped');
		if (outcome === 'conflict') {
			await this.enterConflict(op, review, followUp);
			return;
		}
		await this.complete(op, review, followUp);
	}

	private async settle(op: Operation, review: Review, outcome: RebaseOutcome, followUp: FollowUp): Promise<void> {
		if (outcome === 'conflict') {
			await this.enterConflict(op, review, followUp);
		} else if (outcome === 'finished') {
			await this.finish(op, review, 'All commits were reviewed.');
		} else {
			await this.showCurrent(op, { ...review, phase: 'active', followUp: undefined });
		}
	}

	private async enterConflict(op: Operation, review: Review, followUp: FollowUp): Promise<void> {
		this.deps.logger.warn(`Conflict while replaying '${review.head}'.`);
		await this.set(op, { ...review, phase: 'conflict', followUp });
		this.deps.prompt.warn('The rebase stopped on a conflict. Resolve it, stage the result, then press Continue.');
	}

	private async complete(op: Operation, review: Review, followUp: FollowUp): Promise<void> {
		const { git, logger, progress } = this.deps;
		switch (followUp.kind) {
			case 'approve': {
				progress.busy(`Fast-forwarding ${review.base}`);
				await git.fastForward(review.base, followUp.sha, review.baseSha);
				logger.info(`Approved ${short(followUp.sha)} '${followUp.subject}' onto '${review.base}'.`);
				const approved: Commit = { sha: followUp.sha, subject: followUp.subject };
				const next: Review = { ...review, baseSha: followUp.sha, approved: [...review.approved, approved], followUp: undefined };
				await this.set(op, next);
				await this.startPass(op, next);
				return;
			}
			case 'resume':
				await this.startPass(op, review);
				return;
			case 'quit':
				await this.finish(op, review, `Review ended; the remaining commits of '${review.head}' were kept.`);
				return;
		}
	}

	/** Begins a rebase that stops on the first commit not yet in the base. */
	private async startPass(op: Operation, review: Review): Promise<void> {
		const { git, progress } = this.deps;
		const pending = await git.commits(review.base, review.head);
		if (pending.length === 0) {
			await this.finish(op, { ...review, pending }, 'All commits were reviewed.');
			return;
		}
		progress.busy(`Stopping at ${short(pending[0].sha)}`);
		const outcome = await git.startRebase(review.base, review.head, buildTodo(pending, true), this.reportProgress);
		if (outcome !== 'stopped') {
			throw new ReviewError('The rebase did not stop on the first commit to review.');
		}
		await this.showCurrent(op, { ...review, pending, phase: 'active', followUp: undefined });
	}

	private async showCurrent(op: Operation, review: Review): Promise<void> {
		await this.set(op, review);
		this.deps.logger.info(`Reviewing ${short(review.pending[0].sha)} '${review.pending[0].subject}'.`);
		await this.deps.message.show(await this.deps.git.message('HEAD'));
	}

	private async finish(op: Operation, review: Review, note: string): Promise<void> {
		await this.restoreStashes(review.stashes);
		await this.deps.message.close();
		await this.set(op, undefined);
		this.deps.logger.info(note);
		this.deps.prompt.info(note);
	}

	/**
	 * Confirms the working tree is clean before git replays anything, and
	 * offers to stash tracked changes. The stash is kept for the whole
	 * review, like `--autostash`, because each pass checks out new commits.
	 */
	private async ensureClean(action: string, stashes: readonly string[]): Promise<readonly string[]> {
		const { git, prompt, logger } = this.deps;
		const status = await git.workingTree();
		if (status.unmerged.length > 0) {
			throw new ReviewError('Resolve the conflicted files first.');
		}
		if (status.staged.length === 0 && status.unstaged.length === 0) {
			return stashes;
		}
		logger.warn(`Uncommitted changes present before trying to ${action}.`);
		if (await prompt.chooseDirtyAction(action) === 'cancel') {
			logger.info(`Cancelled: ${action}.`);
			throw new Cancelled();
		}
		const sha = await git.stash();
		logger.info(`Autostashed uncommitted changes as ${short(sha)}.`);
		return [...stashes, sha];
	}

	private async restoreStashes(stashes: readonly string[]): Promise<void> {
		for (const sha of [...stashes].reverse()) {
			try {
				if (await this.deps.git.restoreStash(sha)) {
					this.deps.logger.info(`Restored autostash ${short(sha)}.`);
					continue;
				}
			} catch (error) {
				this.deps.logger.error(`Restoring autostash ${short(sha)} failed: ${describe(error)}`);
			}
			this.deps.logger.warn(`Autostash ${short(sha)} did not apply cleanly and was kept.`);
			this.deps.prompt.warn(`Autostashed changes (${short(sha)}) did not apply cleanly; they remain in \`git stash list\`.`);
		}
	}

	private require(...phases: ReviewPhase[]): Review {
		const review = this.current;
		if (!review || !phases.includes(review.phase)) {
			throw new ReviewError(review ? `That action is not available while the review is ${review.phase}.` : 'No review is in progress.');
		}
		return review;
	}

	private readonly reportProgress: ProgressListener = ({ current, total }) => {
		this.deps.progress.busy(`Rebasing ${current}/${total}`);
	};

	private async run(label: string, body: (op: Operation) => Promise<void>, announce = true): Promise<void> {
		if (this.operation) {
			this.deps.prompt.warn(`Please wait: ${this.operation.label.toLowerCase()} is still running.`);
			return;
		}
		const op = this.begin(label, announce);
		try {
			await body(op);
		} catch (error) {
			this.report(label, error);
		} finally {
			this.end(op);
		}
	}

	private report(label: string, error: unknown): void {
		if (error instanceof Cancelled) {
			return;
		}
		const { logger, prompt } = this.deps;
		if (error instanceof ReviewError) {
			logger.warn(`${label}: ${error.message}`);
			prompt.error(error.message);
			return;
		}
		logger.error(`${label} failed: ${describe(error)}`);
		prompt.error(`${label} failed: ${error instanceof GitError ? error.stderr.trim() || error.message : describe(error)}`);
	}

	private begin(label: string, announce = true): Operation {
		const op = { label, epoch: this.epoch };
		this.operation = op;
		if (announce) {
			this.deps.logger.info(label);
			this.deps.progress.busy(label);
		}
		this.emit();
		return op;
	}

	private end(op: Operation): void {
		if (this.operation !== op) {
			return;
		}
		this.operation = undefined;
		this.deps.progress.rest(restingStatus(this.current));
		this.emit();
	}

	private async set(op: Operation, review: Review | undefined): Promise<void> {
		if (op.epoch !== this.epoch) {
			throw new Cancelled();
		}
		this.current = review;
		this.emit();
		try {
			await this.deps.store.save(review);
		} catch (error) {
			this.deps.logger.error(`Saving review state failed: ${describe(error)}`);
		}
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export function restingStatus(review: Review | undefined): string | undefined {
	if (!review) {
		return undefined;
	}
	const total = review.approved.length + review.pending.length;
	switch (review.phase) {
		case 'paused':
			return 'Editing history';
		case 'conflict':
			return 'Rebase conflict';
		case 'invalidated':
			return 'Review aborted';
		default:
			return `Reviewing ${review.approved.length + 1}/${total}`;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

import { CommitInspector } from '../git/interfaces';
import { Disposable, Logger } from '../ports';
import { Review, underReview } from '../review/reviewState';
import { ChangeIndex } from './fileTreeModel';

export interface ReviewSource {
	readonly review: Review | undefined;
	onDidChange(listener: () => void): Disposable;
}

const EMPTY = new ChangeIndex([]);

/**
 * Tracks which files the commit under review changed. While history is
 * being edited HEAD is followed instead, since amends move it freely.
 */
export class CommitChanges implements Disposable {
	private currentRev: string | undefined;
	private currentIndex = EMPTY;
	private generation = 0;
	private readonly listeners = new Set<() => void>();
	private readonly subscription: Disposable;

	constructor(private readonly source: ReviewSource, private readonly inspector: CommitInspector, private readonly logger: Logger) {
		this.subscription = source.onDidChange(() => void this.sync(false));
	}

	/** Revision whose changes are shown, or undefined outside a review. */
	get rev(): string | undefined {
		return this.currentRev;
	}

	get index(): ChangeIndex {
		return this.currentIndex;
	}

	onDidChange(listener: () => void): Disposable {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Reloads the changes even if the revision appears unchanged. */
	refresh(): Promise<void> {
		return this.sync(true);
	}

	async sync(force: boolean): Promise<void> {
		const review = this.source.review;
		const commit = review ? underReview(review) : undefined;
		const rev = commit && (review?.phase === 'paused' ? 'HEAD' : commit.sha);
		if (!force && rev === this.currentRev) {
			return;
		}
		const generation = ++this.generation;
		let index = EMPTY;
		if (rev) {
			try {
				index = new ChangeIndex(await this.inspector.changedFiles(rev));
			} catch (error) {
				this.logger.error(`Listing changes of ${rev} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (generation !== this.generation) {
			return; // a newer sync superseded this one
		}
		this.currentRev = rev;
		this.currentIndex = index;
		for (const listener of this.listeners) {
			listener();
		}
	}

	dispose(): void {
		this.subscription.dispose();
		this.listeners.clear();
	}
}

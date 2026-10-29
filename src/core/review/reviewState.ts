import { Commit } from '../git/types';

/**
 * - `active`: stopped on `pending[0]`, awaiting approve, reject or quit.
 * - `rejecting`: the reject choices are on screen; git is untouched.
 * - `paused`: the user is rewriting history at the stopped commit.
 * - `conflict`: a replay stopped on conflicts; `followUp` resumes the action.
 * - `invalidated`: the repository changed underneath the review.
 */
export type ReviewPhase = 'active' | 'rejecting' | 'paused' | 'conflict' | 'invalidated';

/** What remains to be done once a replay of the branch finishes. */
export type FollowUp =
	| { readonly kind: 'approve'; readonly sha: string; readonly subject: string }
	| { readonly kind: 'resume' }
	| { readonly kind: 'quit' };

export interface Review {
	readonly base: string;
	readonly head: string;
	/** Where the review last left the base branch. */
	readonly baseSha: string;
	readonly approved: readonly Commit[];
	/** Unreviewed commits, oldest first; the first is the one under review. */
	readonly pending: readonly Commit[];
	readonly phase: ReviewPhase;
	readonly followUp?: FollowUp;
	/** Autostash entries to restore once the review ends. */
	readonly stashes: readonly string[];
	/** Why the review was invalidated. */
	readonly reason?: string;
}

export function underReview(review: Review): Commit | undefined {
	return review.phase === 'active' || review.phase === 'rejecting' || review.phase === 'paused'
		? review.pending[0]
		: undefined;
}

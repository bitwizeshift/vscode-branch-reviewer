import { RepositorySnapshot } from '../git/types';
import { Review } from './reviewState';

/**
 * Explains why the repository no longer matches `review`, or returns
 * undefined while the review can continue. This catches branch switches,
 * manual aborts, and other changes made outside the extension.
 */
export function findInconsistency(review: Review, snapshot: RepositorySnapshot): string | undefined {
	if (review.phase === 'invalidated') {
		return undefined;
	}
	if (!snapshot.rebasing) {
		return 'The rebase is no longer in progress.';
	}
	if (snapshot.rebaseHeadName !== `refs/heads/${review.head}`) {
		return `A different branch (${snapshot.rebaseHeadName ?? 'unknown'}) is being rebased.`;
	}
	if (snapshot.attached) {
		return 'A branch was checked out while the review was in progress.';
	}
	if (snapshot.baseSha !== review.baseSha) {
		return `'${review.base}' was changed outside of the review.`;
	}
	const current = review.pending[0];
	if ((review.phase === 'active' || review.phase === 'rejecting') && snapshot.head !== current?.sha) {
		return 'HEAD moved away from the commit under review.';
	}
	return undefined;
}

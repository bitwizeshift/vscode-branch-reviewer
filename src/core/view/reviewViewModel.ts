import { Review } from '../review/reviewState';

export type ReviewAction =
	| 'start' | 'approve' | 'reject' | 'quit' | 'cancel' | 'edit' | 'abandon' | 'resume' | 'continue' | 'dismiss';

export interface ActionButton {
	readonly action: ReviewAction;
	readonly label: string;
	readonly appearance: 'primary' | 'secondary' | 'danger';
}

export type CommitStatus = 'approved' | 'current' | 'pending';

export interface CommitRow {
	readonly sha: string;
	readonly shortSha: string;
	readonly subject: string;
	readonly status: CommitStatus;
}

export interface Overlay {
	readonly title: string;
	readonly message: string;
	readonly button: ActionButton;
}

export interface SetupModel {
	readonly branches: readonly string[];
	readonly base?: string;
	readonly head?: string;
}

export interface ReviewViewModel {
	readonly setup?: SetupModel;
	readonly header?: { readonly base: string; readonly head: string };
	readonly notice?: string;
	readonly rows: readonly CommitRow[];
	readonly buttons: readonly ActionButton[];
	readonly overlay?: Overlay;
	/** Label of a running operation; controls are disabled while set. */
	readonly busy?: string;
}

const button = (action: ReviewAction, label: string, appearance: ActionButton['appearance'] = 'secondary'): ActionButton =>
	({ action, label, appearance });

function rows(review: Review): CommitRow[] {
	const row = (status: CommitStatus) => ({ sha, subject }: { sha: string; subject: string }): CommitRow =>
		({ sha, shortSha: sha.slice(0, 7), subject, status });
	const [current, ...rest] = review.pending;
	const tracking = review.phase === 'active' || review.phase === 'rejecting' || review.phase === 'paused';
	return [
		...review.approved.map(row('approved')),
		...(current ? [row(tracking ? 'current' : 'pending')(current)] : []),
		...rest.map(row('pending')),
	];
}

/** Projects controller state onto what the Review panel renders. */
export function buildReviewViewModel(review: Review | undefined, setup: SetupModel, busy: string | undefined): ReviewViewModel {
	if (!review) {
		return { setup, rows: [], buttons: [button('start', 'Review', 'primary')], busy };
	}
	const common = { header: { base: review.base, head: review.head }, rows: rows(review), busy };
	switch (review.phase) {
		case 'active':
			return { ...common, buttons: [button('quit', 'Quit'), button('reject', 'Reject'), button('approve', 'Approve', 'primary')] };
		case 'rejecting':
			return { ...common, buttons: [button('cancel', 'Cancel'), button('edit', 'Edit'), button('abandon', 'Abandon', 'danger')] };
		case 'paused':
			return {
				...common,
				notice: 'The rebase is paused on the highlighted commit. Amend it or add commits, then press Resume.',
				buttons: [button('quit', 'Quit'), button('resume', 'Resume', 'primary')],
			};
		case 'conflict':
			return {
				...common,
				buttons: [],
				overlay: {
					title: 'Rebase conflict',
					message: 'Replaying the branch stopped on a conflict. Resolve it, stage the result, then press Continue.',
					button: button('continue', 'Continue', 'primary'),
				},
			};
		case 'invalidated':
			return {
				...common,
				buttons: [],
				overlay: {
					title: 'Review aborted',
					message: `The review was aborted because of a local change. ${review.reason ?? ''}`.trim(),
					button: button('dismiss', 'Dismiss', 'primary'),
				},
			};
	}
}

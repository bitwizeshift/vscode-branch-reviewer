import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildReviewViewModel } from '../../core/view/reviewViewModel';
import { Review, ReviewPhase } from '../../core/review/reviewState';

const setup = { branches: ['main', 'topic'], base: 'main', head: 'topic' };
const review = (phase: ReviewPhase, reason?: string): Review => ({
	base: 'main',
	head: 'topic',
	baseSha: 'b0',
	approved: [{ sha: 'a000000001', subject: 'Done' }],
	pending: [{ sha: 'c000000001', subject: 'Now' }, { sha: 'c000000002', subject: 'Later' }],
	phase,
	stashes: [],
	reason,
});

describe('buildReviewViewModel', () => {
	test('offers branch selection before a review starts', () => {
		const model = buildReviewViewModel(undefined, setup, undefined);
		assert.deepEqual(model.setup, setup);
		assert.deepEqual(model.buttons.map(item => item.action), ['start']);
	});

	const buttonSets: [ReviewPhase, string[]][] = [
		['active', ['quit', 'reject', 'approve']],
		['rejecting', ['cancel', 'edit', 'abandon']],
		['paused', ['quit', 'resume']],
	];
	for (const [phase, expected] of buttonSets) {
		test(`shows ${expected.join('/')} while ${phase}`, () => {
			assert.deepEqual(buildReviewViewModel(review(phase), setup, undefined).buttons.map(item => item.action), expected);
		});
	}

	test('lists approved, current and pending commits from tail to head', () => {
		const model = buildReviewViewModel(review('active'), setup, undefined);
		assert.deepEqual(model.rows.map(row => [row.shortSha, row.status]), [
			['a000000', 'approved'],
			['c000000', 'current'],
			['c000000', 'pending'],
		]);
		assert.deepEqual(model.header, { base: 'main', head: 'topic' });
	});

	test('darkens with a continue button on conflict', () => {
		const model = buildReviewViewModel(review('conflict'), setup, undefined);
		assert.equal(model.overlay?.button.action, 'continue');
		assert.deepEqual(model.buttons, []);
		assert.ok(model.rows.every(row => row.status !== 'current'));
	});

	test('explains an invalidated review', () => {
		const model = buildReviewViewModel(review('invalidated', 'HEAD moved.'), setup, undefined);
		assert.equal(model.overlay?.message, 'The review was aborted because of a local change. HEAD moved.');
		assert.equal(model.overlay?.button.action, 'dismiss');
	});

	test('passes the running operation through', () => {
		assert.equal(buildReviewViewModel(review('active'), setup, 'Approving commit').busy, 'Approving commit');
	});
});

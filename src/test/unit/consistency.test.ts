import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findInconsistency } from '../../core/review/consistency';
import { Review } from '../../core/review/reviewState';
import { RepositorySnapshot } from '../../core/git/types';

const review: Review = {
	base: 'main',
	head: 'topic',
	baseSha: 'b0',
	approved: [],
	pending: [{ sha: 'c1', subject: 'One' }, { sha: 'c2', subject: 'Two' }],
	phase: 'active',
	stashes: [],
};
const healthy: RepositorySnapshot = {
	rebasing: true,
	rebaseHeadName: 'refs/heads/topic',
	head: 'c1',
	attached: false,
	baseSha: 'b0',
};

describe('findInconsistency', () => {
	test('accepts a repository stopped on the commit under review', () => {
		assert.equal(findInconsistency(review, healthy), undefined);
	});

	const cases: { name: string; snapshot: Partial<RepositorySnapshot>; expected: RegExp }[] = [
		{ name: 'a manual abort', snapshot: { rebasing: false }, expected: /no longer in progress/ },
		{ name: 'another branch being rebased', snapshot: { rebaseHeadName: 'refs/heads/other' }, expected: /refs\/heads\/other/ },
		{ name: 'a branch checkout', snapshot: { attached: true }, expected: /checked out/ },
		{ name: 'a moved base', snapshot: { baseSha: 'elsewhere' }, expected: /'main' was changed/ },
		{ name: 'a moved HEAD', snapshot: { head: 'c9' }, expected: /HEAD moved/ },
	];
	for (const { name, snapshot, expected } of cases) {
		test(`detects ${name}`, () => {
			assert.match(findInconsistency(review, { ...healthy, ...snapshot }) ?? '', expected);
		});
	}

	test('lets HEAD move while history is being edited', () => {
		assert.equal(findInconsistency({ ...review, phase: 'paused' }, { ...healthy, head: 'new' }), undefined);
	});

	test('lets HEAD move while resolving a conflict', () => {
		assert.equal(findInconsistency({ ...review, phase: 'conflict' }, { ...healthy, head: 'new' }), undefined);
	});

	test('never re-reports an invalidated review', () => {
		assert.equal(findInconsistency({ ...review, phase: 'invalidated' }, { ...healthy, rebasing: false }), undefined);
	});
});

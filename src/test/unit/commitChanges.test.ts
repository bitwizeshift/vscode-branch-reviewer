import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CommitChanges, ReviewSource } from '../../core/files/commitChanges';
import { CommitInspector } from '../../core/git/interfaces';
import { ChangedFile } from '../../core/git/types';
import { Review } from '../../core/review/reviewState';
import { SilentLogger } from './fakes';

class MockSource implements ReviewSource {
	review: Review | undefined;
	private listener: (() => void) | undefined;
	onDidChange(listener: () => void) {
		this.listener = listener;
		return { dispose: () => { this.listener = undefined; } };
	}
	fire() { this.listener?.(); }
}

class MockInspector implements CommitInspector {
	requested: string[] = [];
	files: Record<string, ChangedFile[]> = {};
	failure: Error | undefined;
	async changedFiles(sha: string) {
		this.requested.push(sha);
		if (this.failure) {
			throw this.failure;
		}
		return this.files[sha] ?? [];
	}
	async parent() { return undefined; }
	async show() { return undefined; }
	async patch() { return ''; }
}

const review = (phase: Review['phase']): Review => ({
	base: 'main', head: 'topic', baseSha: 'b0', approved: [], pending: [{ sha: 'c1', subject: 'One' }], phase, stashes: [],
});

function fixture() {
	const source = new MockSource();
	const inspector = new MockInspector();
	const changes = new CommitChanges(source, inspector, new SilentLogger());
	let notified = 0;
	changes.onDidChange(() => notified++);
	return { source, inspector, changes, notified: () => notified };
}

describe('CommitChanges', () => {
	test('loads the changes of the commit under review', async () => {
		const { source, inspector, changes, notified } = fixture();
		inspector.files.c1 = [{ path: 'a.ts', kind: 'added' }];
		source.review = review('active');
		await changes.sync(false);
		assert.equal(changes.rev, 'c1');
		assert.equal(changes.index.kindOf('a.ts'), 'added');
		assert.equal(notified(), 1);
	});

	test('skips reloading the same commit unless forced', async () => {
		const { source, inspector, changes } = fixture();
		source.review = review('active');
		await changes.sync(false);
		await changes.sync(false);
		await changes.refresh();
		assert.deepEqual(inspector.requested, ['c1', 'c1']);
	});

	test('follows HEAD while history is being edited', async () => {
		const { source, changes } = fixture();
		source.review = review('paused');
		await changes.sync(false);
		assert.equal(changes.rev, 'HEAD');
	});

	test('shows nothing outside a review or during a conflict', async () => {
		const { source, changes } = fixture();
		source.review = review('conflict');
		await changes.sync(false);
		assert.equal(changes.rev, undefined);
		assert.equal(changes.index.size, 0);
	});

	test('falls back to no changes when git fails', async () => {
		const { source, inspector, changes } = fixture();
		inspector.failure = new Error('bad object');
		source.review = review('active');
		await changes.sync(false);
		assert.equal(changes.rev, 'c1');
		assert.equal(changes.index.size, 0);
	});
});

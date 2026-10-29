import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ReviewController, restingStatus } from '../../core/review/reviewController';
import { Review } from '../../core/review/reviewState';
import { clean, MemoryStore, MockGit, MockMessage, MockProgress, MockPrompt } from './reviewFakes';
import { SilentLogger } from './fakes';

const one = { sha: 'c1', subject: 'One' };
const two = { sha: 'c2', subject: 'Two' };
const dirty = { ...clean, unstaged: ['file.ts'] };

function fixture(stored?: Review) {
	const git = new MockGit();
	const message = new MockMessage();
	const prompt = new MockPrompt();
	const progress = new MockProgress();
	const logger = new SilentLogger();
	const store = new MemoryStore();
	store.value = stored;
	const controller = new ReviewController({ git, message, prompt, progress, logger, store });
	return { git, message, prompt, progress, logger, store, controller };
}

function review(overrides: Partial<Review> = {}): Review {
	return { base: 'main', head: 'topic', baseSha: 'b0', approved: [], pending: [one, two], phase: 'active', stashes: [], ...overrides };
}

/** A controller holding `state`, as if restored from a previous window. */
async function reviewing(state: Review = review()) {
	const f = fixture(state);
	f.git.snapshotValue = { rebasing: true, rebaseHeadName: 'refs/heads/topic', head: state.pending[0]?.sha, attached: false, baseSha: state.baseSha };
	await f.controller.restore();
	f.git.calls.length = 0;
	return f;
}

describe('ReviewController.branchChoices', () => {
	test('defaults to the default branch and the checked-out branch', async () => {
		const { git, controller } = fixture();
		git.branchList = ['master', 'topic'];
		assert.deepEqual(await controller.branchChoices(), { branches: ['master', 'topic'], base: 'master', head: 'topic' });
	});
});

describe('ReviewController.start', () => {
	test('stops on the first commit and opens its message', async () => {
		const { git, message, controller } = fixture();
		git.commitQueue = [[one, two], [one, two]];
		await controller.start('main', 'topic');
		assert.deepEqual(git.calls, ['commits main..topic', 'commits main..topic', 'start main topic edit c1 One | pick c2 Two']);
		assert.equal(controller.review?.phase, 'active');
		assert.deepEqual(controller.review?.pending, [one, two]);
		assert.deepEqual(message.shown, ['One\n']);
	});

	const refusals: { name: string; arrange: (git: MockGit) => void; expected: RegExp }[] = [
		{ name: 'an unrebased branch', arrange: git => { git.ancestor = false; }, expected: /must be rebased onto 'main'/ },
		{ name: 'merge commits', arrange: git => { git.merges = true; }, expected: /merge commits/ },
		{ name: 'an empty range', arrange: git => { git.commitQueue = [[]]; }, expected: /no commits beyond/ },
		{ name: 'a rebase in progress', arrange: git => { git.snapshotValue = { ...git.snapshotValue, rebasing: true }; }, expected: /already in progress/ },
		{ name: 'a missing branch', arrange: git => { delete git.refs['refs/heads/topic']; }, expected: /must be local branches/ },
	];
	for (const { name, arrange, expected } of refusals) {
		test(`refuses ${name} with an error toast and no rebase`, async () => {
			const { git, prompt, controller } = fixture();
			git.commitQueue = [[one]];
			arrange(git);
			await controller.start('main', 'topic');
			assert.match(prompt.messages.join('\n'), expected);
			assert.ok(!git.calls.some(call => call.startsWith('start')));
			assert.equal(controller.review, undefined);
		});
	}

	test('refuses identical branches', async () => {
		const { prompt, controller } = fixture();
		await controller.start('main', 'main');
		assert.match(prompt.messages[0], /must differ/);
	});

	test('does nothing when the user cancels over a dirty tree', async () => {
		const { git, prompt, controller } = fixture();
		git.commitQueue = [[one]];
		git.treeQueue = [dirty];
		await controller.start('main', 'topic');
		assert.deepEqual(prompt.asked, ['start the review']);
		assert.ok(!git.calls.includes('stash'));
		assert.equal(controller.review, undefined);
	});

	test('autostashes and keeps the stash for the whole review', async () => {
		const { git, prompt, controller } = fixture();
		git.commitQueue = [[one], [one]];
		git.treeQueue = [dirty];
		prompt.choice = 'autostash';
		await controller.start('main', 'topic');
		assert.deepEqual(controller.review?.stashes, ['s1']);
		assert.ok(!git.calls.some(call => call.startsWith('pop')));
	});

	test('undoes the attempt when the rebase does not stop', async () => {
		const { git, prompt, controller } = fixture();
		git.commitQueue = [[one], [one]];
		git.treeQueue = [dirty];
		prompt.choice = 'autostash';
		git.startOutcome = 'finished';
		await controller.start('main', 'topic');
		assert.deepEqual(git.calls.slice(-2), ['abort', 'pop s1']);
		assert.equal(controller.review, undefined);
	});
});

describe('ReviewController.approve', () => {
	test('fast-forwards an unchanged commit and stops on the next one in place', async () => {
		const { git, message, controller } = await reviewing();
		git.continueQueue = ['stopped'];
		git.messages.HEAD = 'One\n';
		message.text = '# comment\nOne\n';
		await controller.approve();
		assert.deepEqual(git.calls, ['ff main b0->c1', 'todo edit c2 Two', 'continue']);
		assert.deepEqual(controller.review?.approved, [one]);
		assert.deepEqual(controller.review?.pending, [two]);
		assert.equal(controller.review?.baseSha, 'c1');
	});

	test('finishes the review after the last unchanged commit', async () => {
		const { git, message, prompt, controller, store } = await reviewing(review({ pending: [one] }));
		await controller.approve();
		assert.deepEqual(git.calls, ['ff main b0->c1', 'continue']);
		assert.equal(controller.review, undefined);
		assert.equal(store.value, undefined);
		assert.equal(message.closed, 1);
		assert.match(prompt.messages.join(), /All commits were reviewed/);
	});

	test('amends a reworded commit, replays the branch, then fast-forwards and starts the next pass', async () => {
		const { git, message, controller } = await reviewing();
		message.text = 'One, reworded\n';
		git.continueQueue = ['finished'];
		git.commitQueue = [[two]];
		await controller.approve();
		assert.deepEqual(git.calls, ['amend One, reworded', 'continue', 'ff main b0->a1', 'commits main..topic', 'start main topic edit c2 Two']);
		assert.deepEqual(controller.review?.approved, [{ sha: 'a1', subject: 'One, reworded' }]);
		assert.equal(controller.review?.baseSha, 'a1');
	});

	test('signs an unsigned commit before replaying the branch and fast-forwarding', async () => {
		const { git, controller, logger } = await reviewing();
		git.unsigned.add('HEAD');
		git.continueQueue = ['finished'];
		git.commitQueue = [[two]];
		await controller.approve();
		assert.deepEqual(git.calls, ['amend One', 'continue', 'ff main b0->a1', 'commits main..topic', 'start main topic edit c2 Two']);
		assert.deepEqual(controller.review?.approved, [{ sha: 'a1', subject: 'One' }]);
		assert.ok(logger.lines.some(line => line.startsWith('info Signed c1 as a1')));
	});

	test('signs the last commit before ending the review', async () => {
		const { git, controller } = await reviewing(review({ pending: [one] }));
		git.unsigned.add('HEAD');
		git.continueQueue = ['finished'];
		await controller.approve();
		assert.deepEqual(git.calls, ['amend One', 'continue', 'ff main b0->a1', 'commits main..topic']);
		assert.equal(controller.review, undefined);
	});

	test('defers the fast-forward of a reworded commit until a conflict is resolved', async () => {
		const { git, message, controller } = await reviewing();
		message.text = 'Reworded\n';
		git.continueQueue = ['conflict'];
		await controller.approve();
		assert.equal(controller.review?.phase, 'conflict');
		assert.deepEqual(controller.review?.followUp, { kind: 'approve', sha: 'a1', subject: 'Reworded' });
		assert.ok(!git.calls.some(call => call.startsWith('ff')));

		git.continueQueue = ['finished'];
		git.commitQueue = [[two]];
		await controller.continueAfterConflict();
		assert.ok(git.calls.includes('ff main b0->a1'));
		assert.equal(controller.review?.phase, 'active');
	});

	test('asks about uncommitted changes before amending', async () => {
		const { git, message, prompt, controller } = await reviewing();
		message.text = 'Reworded\n';
		git.treeQueue = [{ ...clean, staged: ['x.ts'] }];
		await controller.approve();
		assert.deepEqual(prompt.asked, ['approve the commit']);
		assert.deepEqual(git.calls, []);
		assert.equal(controller.review?.phase, 'active');
	});

	test('reports a moved base and leaves the review in place', async () => {
		const { git, prompt, controller } = await reviewing();
		git.fastForwardError = new Error('cannot lock ref');
		await controller.approve();
		assert.match(prompt.messages.join(), /cannot lock ref/);
		assert.deepEqual(controller.review?.approved, []);
	});

	test('is unavailable outside the active phase', async () => {
		const { git, prompt, controller } = await reviewing(review({ phase: 'paused' }));
		await controller.approve();
		assert.match(prompt.messages[0], /not available while the review is paused/);
		assert.deepEqual(git.calls, []);
	});
});

describe('ReviewController rejection', () => {
	test('cancel returns to the active phase without touching git', async () => {
		const { git, controller } = await reviewing();
		await controller.reject();
		assert.equal(controller.review?.phase, 'rejecting');
		await controller.cancelReject();
		assert.equal(controller.review?.phase, 'active');
		assert.deepEqual(git.calls, []);
	});

	test('edit pauses at the rejected commit', async () => {
		const { git, controller } = await reviewing(review({ phase: 'rejecting' }));
		await controller.edit();
		assert.equal(controller.review?.phase, 'paused');
		assert.deepEqual(git.calls, []);
	});

	test('resume replays the edits and reloads the commit list', async () => {
		const { git, controller } = await reviewing(review({ phase: 'paused' }));
		const inserted = { sha: 'n1', subject: 'Inserted' };
		git.continueQueue = ['stopped', 'finished'];
		git.commitQueue = [[inserted, two]];
		await controller.resume();
		assert.deepEqual(git.calls, ['continue', 'continue', 'commits main..topic', 'start main topic edit n1 Inserted | pick c2 Two']);
		assert.deepEqual(controller.review?.pending, [inserted, two]);
		assert.equal(controller.review?.phase, 'active');
	});

	test('resume enters the conflict phase and continues afterwards', async () => {
		const { git, controller } = await reviewing(review({ phase: 'paused' }));
		git.continueQueue = ['conflict'];
		await controller.resume();
		assert.deepEqual(controller.review?.followUp, { kind: 'resume' });

		git.continueQueue = ['finished'];
		git.commitQueue = [[two]];
		await controller.continueAfterConflict();
		assert.deepEqual(controller.review?.pending, [two]);
	});
});

describe('ReviewController.quit', () => {
	test('replays every remaining commit and ends the review', async () => {
		const { git, controller, message } = await reviewing();
		git.continueQueue = ['finished'];
		await controller.quit();
		assert.deepEqual(git.calls, ['continue']);
		assert.equal(controller.review, undefined);
		assert.equal(message.closed, 1);
	});

	test('restores autostashed changes once the replay finishes', async () => {
		const { git, prompt, controller } = await reviewing(review({ stashes: ['s0'] }));
		git.treeQueue = [dirty];
		prompt.choice = 'autostash';
		await controller.quit();
		assert.deepEqual(git.calls, ['stash', 'continue', 'pop s1', 'pop s0']);
	});

	test('warns when an autostash no longer applies cleanly', async () => {
		const { git, prompt, controller } = await reviewing(review({ stashes: ['s0'] }));
		git.stashRestores = false;
		await controller.quit();
		assert.match(prompt.messages.join(), /did not apply cleanly/);
		assert.equal(controller.review, undefined);
	});
});

describe('ReviewController.continueAfterConflict', () => {
	test('refuses while conflicts remain', async () => {
		const { git, prompt, controller } = await reviewing(review({ phase: 'conflict', followUp: { kind: 'quit' } }));
		git.treeQueue = [{ ...clean, unmerged: ['a.ts'] }];
		await controller.continueAfterConflict();
		assert.match(prompt.messages[0], /Resolve and stage 1 conflicted/);
		assert.deepEqual(git.calls, []);
	});

	test('refuses unstaged changes rather than stashing the resolution', async () => {
		const { git, prompt, controller } = await reviewing(review({ phase: 'conflict', followUp: { kind: 'quit' } }));
		git.treeQueue = [dirty];
		await controller.continueAfterConflict();
		assert.match(prompt.messages[0], /unstaged changes/);
		assert.ok(!git.calls.includes('stash'));
	});

	test('runs the interrupted follow-up', async () => {
		const { git, controller } = await reviewing(review({ phase: 'conflict', followUp: { kind: 'quit' } }));
		git.treeQueue = [{ ...clean, staged: ['a.ts'] }];
		await controller.continueAfterConflict();
		assert.deepEqual(git.calls, ['continue']);
		assert.equal(controller.review, undefined);
	});
});

describe('ReviewController.abort', () => {
	test('aborts the rebase and clears the review', async () => {
		const { git, controller, store, message } = await reviewing();
		await controller.abort();
		assert.deepEqual(git.calls, ['abort']);
		assert.equal(controller.review, undefined);
		assert.equal(store.value, undefined);
		assert.equal(message.closed, 1);
	});

	test('resets even when every cleanup step fails', async () => {
		const { git, controller, store, message, prompt } = await reviewing(review({ stashes: ['s0'] }));
		git.abortError = new Error('index.lock exists');
		git.stashRestores = false;
		message.closeError = new Error('editor gone');
		await controller.abort();
		assert.equal(controller.review, undefined);
		assert.equal(store.value, undefined);
		assert.match(prompt.messages.join(), /reset anyway/);
	});

	test('still attempts the abort when the repository cannot be inspected', async () => {
		const { git, controller } = await reviewing();
		git.snapshotError = new Error('broken');
		await controller.abort();
		assert.deepEqual(git.calls, ['abort']);
	});

	test('leaves an unrelated rebase alone', async () => {
		const { git, controller } = await reviewing(review({ phase: 'invalidated', reason: 'x' }));
		git.snapshotValue = { rebasing: true, rebaseHeadName: 'refs/heads/other', attached: false };
		await controller.abort();
		assert.deepEqual(git.calls, []);
		assert.equal(controller.review, undefined);
	});

	test('discards results of the operation it interrupts', async () => {
		const { git, controller } = await reviewing();
		let release!: () => void;
		git.continueQueue = ['stopped'];
		const originalFastForward = git.fastForward.bind(git);
		git.fastForward = async (...args) => {
			await new Promise<void>(resolve => { release = resolve; });
			return originalFastForward(...args);
		};
		const approving = controller.approve();
		await new Promise(resolve => setImmediate(resolve));
		await controller.abort();
		release();
		await approving;
		assert.equal(controller.review, undefined);
	});
});

describe('ReviewController.checkRepository', () => {
	test('invalidates the review when the branch changes underneath it', async () => {
		const { git, controller, logger } = await reviewing();
		git.snapshotValue = { rebasing: false, attached: true, baseSha: 'b0' };
		await controller.checkRepository();
		assert.equal(controller.review?.phase, 'invalidated');
		assert.match(controller.review?.reason ?? '', /no longer in progress/);
		assert.ok(logger.lines.some(line => line.startsWith('warn Review invalidated')));
	});

	test('invalidates a restored review that no longer matches', async () => {
		const f = fixture(review());
		f.git.snapshotValue = { rebasing: false, attached: true, baseSha: 'b0' };
		await f.controller.restore();
		assert.equal(f.controller.review?.phase, 'invalidated');
	});

	test('dismiss clears an invalidated review without touching git', async () => {
		const { git, controller } = await reviewing(review({ phase: 'invalidated', reason: 'x' }));
		await controller.dismiss();
		assert.equal(controller.review, undefined);
		assert.deepEqual(git.calls, []);
	});
});

describe('ReviewController progress', () => {
	test('reports rebase positions while replaying', async () => {
		const { git, progress, controller } = await reviewing(review({ phase: 'paused' }));
		git.progressToReport = { current: 4, total: 10 };
		git.commitQueue = [[two]];
		await controller.resume();
		assert.ok(progress.updates.includes('Rebasing 4/10'));
		assert.equal(progress.resting, 'Reviewing 1/1');
	});

	test('rejects a second action while one is running', async () => {
		const { git, prompt, controller } = await reviewing();
		let release!: () => void;
		git.fastForward = async () => { await new Promise<void>(resolve => { release = resolve; }); };
		const approving = controller.approve();
		await new Promise(resolve => setImmediate(resolve));
		await controller.quit();
		assert.match(prompt.messages.join(), /still running/);
		release();
		await approving;
	});
});

describe('restingStatus', () => {
	test('counts the commit under review among all commits', () => {
		assert.equal(restingStatus(review({ approved: [one], pending: [two] })), 'Reviewing 2/2');
	});

	test('names the non-reviewing phases', () => {
		assert.equal(restingStatus(review({ phase: 'conflict' })), 'Rebase conflict');
		assert.equal(restingStatus(undefined), undefined);
	});
});

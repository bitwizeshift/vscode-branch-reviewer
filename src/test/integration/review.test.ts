import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BranchReviewerApi } from '../../extension';
import { api, commit, editMessage, git, reset, root, until, write } from './fixture';

suite('Branch review', () => {
	let reviewer: BranchReviewerApi;
	let shas: string[];

	suiteSetup(async () => {
		reviewer = await api();
	});

	setup(async () => {
		await reset(reviewer);
		git('checkout', '--quiet', '-b', 'topic');
		shas = [
			commit('Add greeting', { 'greeting.txt': 'hello\n' }),
			commit('Extend greeting', { 'greeting.txt': 'hello\nworld\n' }),
			commit('Add notes', { 'docs/notes.md': 'notes\n' }),
		];
	});

	suiteTeardown(async () => {
		await reset(reviewer);
	});

	const review = () => reviewer.controller.review;

	test('refuses a branch that is not rebased onto the base', async () => {
		git('checkout', '--quiet', 'main');
		commit('Diverge', { 'other.txt': 'x\n' });
		const before = git('rev-parse', 'main');
		await reviewer.controller.start('main', 'topic');
		assert.equal(review(), undefined);
		assert.equal(git('rev-parse', 'main'), before);
		assert.ok(!fs.existsSync(path.join(root, '.git', 'rebase-merge')));
	});

	test('stops on the first commit and shows its message and changes', async () => {
		await reviewer.controller.start('main', 'topic');
		assert.equal(review()?.phase, 'active');
		assert.equal(git('rev-parse', 'HEAD'), shas[0]);
		const message = vscode.workspace.textDocuments.find(doc => doc.fileName.endsWith('COMMIT_EDITMSG'));
		assert.ok(message?.getText().startsWith('Add greeting'));
		assert.equal(message?.languageId, 'git-commit');
		await reviewer.changes.refresh();
		assert.equal(reviewer.changes.rev, shas[0]);
		assert.equal(reviewer.changes.index.kindOf('greeting.txt'), 'added');
	});

	test('approving an unchanged commit fast-forwards the base onto it', async () => {
		await reviewer.controller.start('main', 'topic');
		await reviewer.controller.approve();
		assert.equal(git('rev-parse', 'main'), shas[0]);
		assert.equal(git('rev-parse', 'HEAD'), shas[1]);
		assert.deepEqual(review()?.approved.map(item => item.sha), [shas[0]]);
	});

	test('approving a reworded commit amends it before fast-forwarding', async () => {
		await reviewer.controller.start('main', 'topic');
		await editMessage('Add a friendly greeting\n');
		await reviewer.controller.approve();
		assert.equal(git('log', '-1', '--format=%s', 'main'), 'Add a friendly greeting');
		assert.equal(git('rev-list', '--count', 'main'), '2');
		assert.equal(git('log', '-1', '--format=%s', 'HEAD'), 'Extend greeting');
		assert.equal(git('rev-parse', 'HEAD^'), git('rev-parse', 'main'));
		assert.equal(review()?.pending.length, 2);
	});

	test('approving every commit ends the review on the head branch', async () => {
		await reviewer.controller.start('main', 'topic');
		await reviewer.controller.approve();
		await reviewer.controller.approve();
		await reviewer.controller.approve();
		assert.equal(review(), undefined);
		assert.equal(git('rev-parse', 'main'), shas[2]);
		assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic');
	});

	test('quitting keeps the remaining commits and finishes the rebase', async () => {
		await reviewer.controller.start('main', 'topic');
		await reviewer.controller.quit();
		assert.equal(review(), undefined);
		assert.equal(git('rev-parse', 'topic'), shas[2]);
		assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic');
	});

	test('edits made while paused are replayed and reloaded on resume', async () => {
		await reviewer.controller.start('main', 'topic');
		await reviewer.controller.reject();
		await reviewer.controller.edit();
		assert.equal(review()?.phase, 'paused');
		git('commit', '--quiet', '--amend', '--message', 'Add greeting (amended)');
		commit('Insert a commit', { 'inserted.txt': 'new\n' });
		await reviewer.controller.resume();
		assert.equal(review()?.phase, 'active');
		assert.deepEqual(review()?.pending.map(item => item.subject), ['Add greeting (amended)', 'Insert a commit', 'Extend greeting', 'Add notes']);
	});

	test('a conflict while resuming darkens the review until Continue', async () => {
		await reviewer.controller.start('main', 'topic');
		await reviewer.controller.reject();
		await reviewer.controller.edit();
		write('greeting.txt', 'howdy\n');
		git('commit', '--quiet', '--all', '--amend', '--no-edit');
		await reviewer.controller.resume();
		assert.equal(review()?.phase, 'conflict');

		write('greeting.txt', 'howdy\nworld\n');
		git('add', 'greeting.txt');
		await reviewer.controller.continueAfterConflict();
		assert.equal(review()?.phase, 'active');
		assert.equal(review()?.pending.length, 3);
	});

	test('a rebase aborted from outside invalidates the review', async () => {
		await reviewer.controller.start('main', 'topic');
		git('rebase', '--abort');
		await until(reviewer, () => review()?.phase === 'invalidated');
		assert.match(review()?.reason ?? '', /no longer in progress/);
		await reviewer.controller.dismiss();
		assert.equal(review(), undefined);
	});

	test('switching branches invalidates the review', async () => {
		await reviewer.controller.start('main', 'topic');
		git('checkout', '--quiet', 'main');
		await until(reviewer, () => review()?.phase === 'invalidated');
	});

	test('abort resets a review whose rebase was destroyed', async () => {
		await reviewer.controller.start('main', 'topic');
		fs.rmSync(path.join(root, '.git', 'rebase-merge'), { recursive: true, force: true });
		await reviewer.controller.abort();
		assert.equal(review(), undefined);
	});

	test('abort restores the branch to where it started', async () => {
		await reviewer.controller.start('main', 'topic');
		await reviewer.controller.abort();
		assert.equal(review(), undefined);
		assert.equal(git('rev-parse', 'topic'), shas[2]);
		assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic');
	});
});

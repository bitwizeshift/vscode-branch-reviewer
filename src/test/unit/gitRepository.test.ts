import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { discoverPaths, GitInspector, GitRepository, RepositoryPaths, shellQuote } from '../../core/git/gitRepository';
import { GitError, RebaseProgress } from '../../core/git/types';
import { MemoryFiles, ScriptedRunner } from './fakes';

const paths: RepositoryPaths = {
	root: '/repo',
	gitDir: '/repo/.git',
	rebaseMergeDir: '/repo/.git/rebase-merge',
	rebaseApplyDir: '/repo/.git/rebase-apply',
	reviewerDir: '/repo/.git/branch-reviewer',
};
const todoPath = '/repo/.git/branch-reviewer/git-rebase-todo';

function fixture() {
	const runner = new ScriptedRunner();
	const files = new MemoryFiles();
	return { runner, files, git: new GitRepository(runner, files, paths) };
}

describe('discoverPaths', () => {
	test('resolves relative rebase paths against the top level', async () => {
		const runner = new ScriptedRunner().on(
			'rev-parse --show-toplevel --absolute-git-dir --git-path rebase-merge --git-path rebase-apply',
			{ stdout: '/repo\n/repo/.git\n.git/rebase-merge\n/abs/rebase-apply\n' },
		);
		assert.deepEqual(await discoverPaths(runner), { ...paths, rebaseApplyDir: '/abs/rebase-apply' });
	});

	test('fails outside a repository', async () => {
		const runner = new ScriptedRunner().on(
			'rev-parse --show-toplevel --absolute-git-dir --git-path rebase-merge --git-path rebase-apply',
			{ code: 128, stderr: 'not a git repository' },
		);
		await assert.rejects(discoverPaths(runner), GitError);
	});
});

describe('shellQuote', () => {
	test('escapes embedded single quotes', () => {
		assert.equal(shellQuote(`/it's/here`), `'/it'\\''s/here'`);
	});
});

describe('GitRepository', () => {
	test('strips the remote from the origin HEAD hint', async () => {
		const { runner, git } = fixture();
		runner.on('symbolic-ref --quiet --short refs/remotes/origin/HEAD', { stdout: 'origin/main\n' });
		runner.on('config --get init.defaultBranch', { code: 1 });
		assert.deepEqual(await git.defaultBranchHints(), { originHead: 'main', initDefault: undefined });
	});

	test('distinguishes a non-ancestor from a git failure', async () => {
		const { runner, git } = fixture();
		runner.on('merge-base --is-ancestor base topic', { code: 1 });
		assert.equal(await git.isAncestor('base', 'topic'), false);
		runner.on('merge-base --is-ancestor base topic', { code: 128, stderr: 'bad revision' });
		await assert.rejects(git.isAncestor('base', 'topic'), GitError);
	});

	test('reads the rebased branch from the rebase directory', async () => {
		const { runner, files, git } = fixture();
		files.directories.add(paths.rebaseMergeDir);
		files.contents.set(`${paths.rebaseMergeDir}/head-name`, 'refs/heads/topic\n');
		runner.on('symbolic-ref --quiet HEAD', { code: 1 });
		runner.on('rev-parse --verify --quiet --end-of-options HEAD^{commit}', { stdout: 'c1\n' });
		runner.on('rev-parse --verify --quiet --end-of-options refs/heads/main^{commit}', { stdout: 'b0\n' });
		assert.deepEqual(await git.snapshot('main'), {
			rebasing: true,
			rebaseHeadName: 'refs/heads/topic',
			head: 'c1',
			attached: false,
			baseSha: 'b0',
		});
	});

	test('starts a rebase with the prepared todo as its sequence editor', async () => {
		const { runner, files, git } = fixture();
		runner.on('rebase --interactive main topic', () => {
			files.directories.add(paths.rebaseMergeDir);
			return { stderrChunks: ['Rebasing (1/2)\r'] };
		});
		const progress: RebaseProgress[] = [];
		const outcome = await git.startRebase('main', 'topic', 'edit a1 One\n', value => progress.push(value));
		assert.equal(outcome, 'stopped');
		assert.equal(files.contents.get(todoPath), 'edit a1 One\n');
		const call = runner.calls.find(entry => entry.args[0] === 'rebase');
		assert.equal(call?.env?.GIT_SEQUENCE_EDITOR, `cp '${todoPath}'`);
		assert.equal(call?.env?.GIT_EDITOR, 'true');
		assert.deepEqual(progress, [{ current: 1, total: 2 }]);
	});

	test('reports a finished rebase once the rebase directory is gone', async () => {
		const { git } = fixture();
		assert.equal(await git.continueRebase(() => undefined), 'finished');
	});

	test('reports a conflict when unmerged paths remain', async () => {
		const { runner, files, git } = fixture();
		files.directories.add(paths.rebaseMergeDir);
		runner.on('rebase --continue', { code: 1, stderr: 'CONFLICT' });
		runner.on('status --porcelain=v1 -z --untracked-files=no', { stdout: 'UU a.ts\0' });
		assert.equal(await git.continueRebase(() => undefined), 'conflict');
	});

	test('surfaces refusals that leave the rebase stopped without conflicts', async () => {
		const { runner, files, git } = fixture();
		files.directories.add(paths.rebaseMergeDir);
		runner.on('rebase --continue', { code: 1, stderr: 'You have unstaged changes' });
		await assert.rejects(git.continueRebase(() => undefined), /unstaged changes/);
	});

	test('tolerates an abort failure when no rebase remains', async () => {
		const { runner, git } = fixture();
		runner.on('rebase --abort', { code: 128, stderr: 'No rebase in progress?' });
		await git.abortRebase();
	});

	test('propagates an abort failure while the rebase persists', async () => {
		const { runner, files, git } = fixture();
		files.directories.add(paths.rebaseMergeDir);
		runner.on('rebase --abort', { code: 128, stderr: 'index.lock exists' });
		await assert.rejects(git.abortRebase(), /index\.lock/);
	});

	test('amends from stdin and returns the new HEAD', async () => {
		const { runner, git } = fixture();
		runner.on('rev-parse HEAD', { stdout: 'n3w\n' });
		assert.equal(await git.amend('Reworded\n'), 'n3w');
		const amend = runner.calls.find(call => call.args[0] === 'commit');
		assert.equal(amend?.input, 'Reworded\n');
	});

	test('fast-forwards with the expected old value', async () => {
		const { runner, git } = fixture();
		await git.fastForward('main', 'c1', 'b0');
		assert.deepEqual(runner.commands(), ['update-ref -m branch-reviewer: approve refs/heads/main c1 b0']);
	});

	test('pops the stash entry by its position', async () => {
		const { runner, git } = fixture();
		runner.on('stash list --format=%H', { stdout: 'other\nours\n' });
		assert.equal(await git.restoreStash('ours'), true);
		assert.ok(runner.commands().includes('stash pop stash@{1}'));
	});

	test('reports a missing stash entry without popping', async () => {
		const { runner, git } = fixture();
		runner.on('stash list --format=%H', { stdout: 'other\n' });
		assert.equal(await git.restoreStash('ours'), false);
		assert.ok(!runner.commands().some(command => command.startsWith('stash pop')));
	});
});

describe('GitInspector', () => {
	test('returns undefined for files absent from a revision', async () => {
		const runner = new ScriptedRunner().on('show c1:missing.ts', { code: 128 });
		assert.equal(await new GitInspector(runner).show('c1', 'missing.ts'), undefined);
	});
});

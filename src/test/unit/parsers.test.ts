import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildTodo, parseCommits, parseNameStatus, parseRebaseProgress, parseStatus } from '../../core/git/parsers';

describe('parseCommits', () => {
	test('splits sha from subject on the field separator', () => {
		assert.deepEqual(parseCommits('aaa\x1fFirst: with colon\nbbb\x1fSecond\n'), [
			{ sha: 'aaa', subject: 'First: with colon' },
			{ sha: 'bbb', subject: 'Second' },
		]);
	});

	test('returns nothing for empty output', () => {
		assert.deepEqual(parseCommits(''), []);
	});
});

describe('buildTodo', () => {
	const commits = [{ sha: 'a1', subject: 'One' }, { sha: 'b2', subject: 'Two' }];

	test('edits only the first commit when stopping', () => {
		assert.equal(buildTodo(commits, true), 'edit a1 One\npick b2 Two\n');
	});

	test('picks every commit otherwise', () => {
		assert.equal(buildTodo(commits, false), 'pick a1 One\npick b2 Two\n');
	});
});

describe('parseRebaseProgress', () => {
	test('reports the last marker in a chunk', () => {
		assert.deepEqual(parseRebaseProgress('Rebasing (3/10)\rRebasing (4/10)\r'), { current: 4, total: 10 });
	});

	test('ignores chunks without a marker', () => {
		assert.equal(parseRebaseProgress('Successfully rebased'), undefined);
	});
});

describe('parseNameStatus', () => {
	test('maps status letters and keeps both paths of a rename', () => {
		assert.deepEqual(parseNameStatus('A\0new.ts\0M\0src/a.ts\0D\0gone.md\0R087\0old.ts\0moved.ts\0'), [
			{ path: 'new.ts', kind: 'added' },
			{ path: 'src/a.ts', kind: 'modified' },
			{ path: 'gone.md', kind: 'deleted' },
			{ path: 'moved.ts', kind: 'renamed', oldPath: 'old.ts' },
		]);
	});

	test('treats copies as additions of the destination', () => {
		assert.deepEqual(parseNameStatus('C100\0a.ts\0b.ts\0'), [{ path: 'b.ts', kind: 'added' }]);
	});
});

describe('parseStatus', () => {
	test('separates staged, unstaged and unmerged entries', () => {
		const status = parseStatus('M  staged.ts\0 M unstaged.ts\0MM both.ts\0UU conflict.ts\0');
		assert.deepEqual(status, {
			unmerged: ['conflict.ts'],
			staged: ['staged.ts', 'both.ts'],
			unstaged: ['unstaged.ts', 'both.ts'],
		});
	});

	test('skips the original path that follows a rename', () => {
		assert.deepEqual(parseStatus('R  new.ts\0old.ts\0'), { unmerged: [], staged: ['new.ts'], unstaged: [] });
	});

	test('ignores untracked entries', () => {
		assert.deepEqual(parseStatus('?? scratch.txt\0'), { unmerged: [], staged: [], unstaged: [] });
	});
});

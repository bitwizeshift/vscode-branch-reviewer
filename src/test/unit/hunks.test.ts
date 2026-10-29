import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseLineChanges } from '../../core/diff/hunks';

describe('parseLineChanges', () => {
	test('classifies additions, modifications and deletions', () => {
		const patch = [
			'diff --git a/f b/f',
			'@@ -0,0 +1,2 @@',
			'+a',
			'+b',
			'@@ -5,2 +7,3 @@ context',
			'-x',
			'+y',
			'@@ -10,3 +11,0 @@',
			'-z',
		].join('\n');
		assert.deepEqual(parseLineChanges(patch), {
			added: [{ start: 0, end: 1 }],
			modified: [{ start: 6, end: 8 }],
			deleted: [10],
		});
	});

	test('treats omitted counts as a single line', () => {
		assert.deepEqual(parseLineChanges('@@ -3 +3 @@'), { added: [], modified: [{ start: 2, end: 2 }], deleted: [] });
	});

	test('anchors a deletion at the top of the file to the first line', () => {
		assert.deepEqual(parseLineChanges('@@ -1,2 +0,0 @@').deleted, [0]);
	});

	test('ignores lines that merely look like hunk content', () => {
		assert.deepEqual(parseLineChanges('+@@ -1 +1 @@'), { added: [], modified: [], deleted: [] });
	});
});

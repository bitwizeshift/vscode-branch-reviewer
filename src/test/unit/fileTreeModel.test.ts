import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChangeIndex, childNodes } from '../../core/files/fileTreeModel';

const index = new ChangeIndex([
	{ path: 'src/new.ts', kind: 'added' },
	{ path: 'src/lib/edited.ts', kind: 'modified' },
	{ path: 'docs/old.md', kind: 'deleted' },
	{ path: 'assets/fresh/a.png', kind: 'added' },
	{ path: 'moved.ts', kind: 'renamed', oldPath: 'was.ts' },
]);

describe('ChangeIndex', () => {
	test('reports file kinds directly', () => {
		assert.equal(index.kindOf('src/new.ts'), 'added');
		assert.equal(index.kindOf('README.md'), undefined);
	});

	test('tells changed files apart from folders', () => {
		assert.equal(index.isChangedFile('src/new.ts'), true);
		assert.equal(index.isChangedFile('src'), false);
	});

	test('summarises folders from everything beneath them', () => {
		assert.equal(index.kindOf('assets'), 'added');
		assert.equal(index.kindOf('docs'), 'deleted');
		assert.equal(index.kindOf('src'), 'modified');
		assert.equal(index.kindOf('src/lib'), 'modified');
	});
});

describe('childNodes', () => {
	const root = [
		{ name: '.git', directory: true },
		{ name: 'src', directory: true },
		{ name: 'README.md', directory: false },
		{ name: 'moved.ts', directory: false },
		{ name: 'assets', directory: true },
	];

	test('lists folders first and hides the git directory', () => {
		assert.deepEqual(childNodes('', root, index, false).map(node => node.name), ['assets', 'docs', 'src', 'moved.ts', 'README.md']);
	});

	test('adds folders that only hold deleted files', () => {
		const docs = childNodes('', root, index, false).find(node => node.name === 'docs');
		assert.deepEqual(docs, { path: 'docs', name: 'docs', directory: true, change: 'deleted', deleted: true });
	});

	test('marks deleted files inside an existing folder', () => {
		assert.deepEqual(childNodes('docs', [], index, false), [
			{ path: 'docs/old.md', name: 'old.md', directory: false, change: 'deleted', deleted: true },
		]);
	});

	test('keeps only changed paths when filtering', () => {
		assert.deepEqual(childNodes('', root, index, true).map(node => node.name), ['assets', 'docs', 'src', 'moved.ts']);
	});

	test('decorates nested entries with their own kind', () => {
		const nodes = childNodes('src', [{ name: 'lib', directory: true }, { name: 'new.ts', directory: false }], index, false);
		assert.deepEqual(nodes.map(node => [node.path, node.change]), [['src/lib', 'modified'], ['src/new.ts', 'added']]);
	});
});

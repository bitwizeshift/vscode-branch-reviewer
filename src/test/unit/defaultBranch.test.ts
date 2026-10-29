import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultBase, defaultHead } from '../../core/review/defaultBranch';

describe('defaultBase', () => {
	test('prefers the branch origin/HEAD names', () => {
		assert.equal(defaultBase(['develop', 'main', 'topic'], { originHead: 'develop', initDefault: 'main' }, 'topic'), 'develop');
	});

	test('falls back to init.defaultBranch when origin/HEAD has no local branch', () => {
		assert.equal(defaultBase(['trunk', 'topic'], { originHead: 'main', initDefault: 'trunk' }, 'topic'), 'trunk');
	});

	test('falls back to master by convention', () => {
		assert.equal(defaultBase(['feature', 'master'], {}, 'feature'), 'master');
	});

	test('picks a branch other than the current one as a last resort', () => {
		assert.equal(defaultBase(['topic', 'release'], {}, 'topic'), 'release');
	});

	test('has no default without branches', () => {
		assert.equal(defaultBase([], {}, undefined), undefined);
	});
});

describe('defaultHead', () => {
	test('uses the checked-out branch', () => {
		assert.equal(defaultHead(['main', 'topic'], 'main', 'topic'), 'topic');
	});

	test('avoids the base when HEAD is detached', () => {
		assert.equal(defaultHead(['main', 'topic'], 'main', undefined), 'topic');
	});
});

import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { NodeGitRunner, Spawn } from '../../adapters/nodeGitRunner';
import { SilentLogger } from './fakes';

class FakeChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin = new PassThrough();
	input = '';

	constructor() {
		super();
		this.stdin.on('data', chunk => { this.input += chunk.toString(); });
	}
}

function fixture() {
	const child = new FakeChild();
	const spawned: { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string }[] = [];
	const spawn: Spawn = (command, args, options) => {
		spawned.push({ command, args, env: options.env, cwd: options.cwd?.toString() });
		return child as unknown as ChildProcessWithoutNullStreams;
	};
	const runner = new NodeGitRunner(spawn, '/repo', { PATH: '/bin', LC_ALL: 'de_DE' }, new SilentLogger());
	return { child, spawned, runner };
}

describe('NodeGitRunner', () => {
	test('collects output and forwards stderr as it arrives', async () => {
		const { child, runner } = fixture();
		const chunks: string[] = [];
		const pending = runner.run({ args: ['status'], onStderr: chunk => chunks.push(chunk) });
		child.stdout.write('out');
		child.stderr.write('Rebasing (1/2)\r');
		await new Promise(resolve => setImmediate(resolve));
		child.emit('close', 0);
		assert.deepEqual(await pending, { code: 0, stdout: 'out', stderr: 'Rebasing (1/2)\r' });
		assert.deepEqual(chunks, ['Rebasing (1/2)\r']);
	});

	test('runs in the repository with a fixed locale over the inherited environment', async () => {
		const { child, spawned, runner } = fixture();
		const pending = runner.run({ args: ['log'], env: { GIT_EDITOR: 'true' } });
		child.emit('close', 0);
		await pending;
		assert.equal(spawned[0].cwd, '/repo');
		assert.equal(spawned[0].env?.PATH, '/bin');
		assert.equal(spawned[0].env?.LC_ALL, 'C');
		assert.equal(spawned[0].env?.GIT_EDITOR, 'true');
	});

	test('writes input to stdin', async () => {
		const { child, runner } = fixture();
		const pending = runner.run({ args: ['stripspace'], input: 'text' });
		await new Promise(resolve => setImmediate(resolve));
		child.emit('close', 0);
		await pending;
		assert.equal(child.input, 'text');
	});

	test('rejects when git cannot be spawned', async () => {
		const { child, runner } = fixture();
		const pending = runner.run({ args: ['status'] });
		child.emit('error', new Error('ENOENT'));
		await assert.rejects(pending, /ENOENT/);
	});
});

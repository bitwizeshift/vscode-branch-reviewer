import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { GitInvocation, GitResult, GitRunner, Logger } from '../core/ports';

export type Spawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** Runs git as a child process rooted at the repository. */
export class NodeGitRunner implements GitRunner {
	constructor(
		private readonly spawn: Spawn,
		private readonly cwd: string,
		private readonly baseEnv: NodeJS.ProcessEnv,
		private readonly logger: Logger,
	) {}

	run(invocation: GitInvocation): Promise<GitResult> {
		const label = `git ${invocation.args.join(' ')}`;
		this.logger.debug(`$ ${label}`);
		return new Promise((resolve, reject) => {
			const child = this.spawn('git', invocation.args, {
				cwd: this.cwd,
				// Progress lines and messages must be parseable regardless of locale.
				env: { ...this.baseEnv, ...invocation.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Buffer) => {
				stderr.push(chunk);
				invocation.onStderr?.(chunk.toString('utf8'));
			});
			child.stdin.on('error', () => undefined);
			child.on('error', error => {
				this.logger.error(`${label}: ${error.message}`);
				reject(error);
			});
			child.on('close', code => {
				const result = {
					code: code ?? 1,
					stdout: Buffer.concat(stdout).toString('utf8'),
					stderr: Buffer.concat(stderr).toString('utf8'),
				};
				if (result.code !== 0) {
					this.logger.debug(`${label} exited ${result.code}: ${result.stderr.trim()}`);
				}
				resolve(result);
			});
			child.stdin.end(invocation.input);
		});
	}
}

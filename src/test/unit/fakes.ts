import { GitInvocation, GitResult, GitRunner, Logger, TextFiles } from '../../core/ports';

type Reply = Partial<GitResult> & { stderrChunks?: readonly string[] };

/**
 * Runner that answers git invocations from a script keyed by the joined
 * argument list. Unscripted commands succeed with empty output, and every
 * invocation is recorded for assertions.
 */
export class ScriptedRunner implements GitRunner {
	readonly calls: GitInvocation[] = [];
	private readonly replies = new Map<string, Reply | ((invocation: GitInvocation) => Reply)>();

	on(args: string, reply: Reply | ((invocation: GitInvocation) => Reply)): this {
		this.replies.set(args, reply);
		return this;
	}

	commands(): string[] {
		return this.calls.map(call => call.args.join(' '));
	}

	async run(invocation: GitInvocation): Promise<GitResult> {
		this.calls.push(invocation);
		const entry = this.replies.get(invocation.args.join(' '));
		const reply = typeof entry === 'function' ? entry(invocation) : entry ?? {};
		for (const chunk of reply.stderrChunks ?? []) {
			invocation.onStderr?.(chunk);
		}
		return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
	}
}

export class MemoryFiles implements TextFiles {
	readonly contents = new Map<string, string>();
	readonly directories = new Set<string>();

	async read(path: string): Promise<string | undefined> {
		return this.contents.get(path);
	}

	async write(path: string, text: string): Promise<void> {
		this.contents.set(path, text);
	}

	async exists(path: string): Promise<boolean> {
		return this.directories.has(path) || this.contents.has(path);
	}
}

export class SilentLogger implements Logger {
	readonly lines: string[] = [];
	debug(message: string): void { this.lines.push(`debug ${message}`); }
	info(message: string): void { this.lines.push(`info ${message}`); }
	warn(message: string): void { this.lines.push(`warn ${message}`); }
	error(message: string): void { this.lines.push(`error ${message}`); }
}

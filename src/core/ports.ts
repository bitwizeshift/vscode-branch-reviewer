/**
 * Abstractions the review core depends on. Nothing in `core/` imports
 * `vscode` or touches the process or file system directly; adapters provide
 * these at the composition root, and unit tests provide mocks.
 */

export interface GitResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface GitInvocation {
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly input?: string;
	readonly onStderr?: (chunk: string) => void;
}

export interface GitRunner {
	run(invocation: GitInvocation): Promise<GitResult>;
}

export interface TextFiles {
	read(path: string): Promise<string | undefined>;
	write(path: string, text: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export type DirtyChoice = 'cancel' | 'autostash';

export interface Prompt {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	/** Asks what to do with uncommitted changes before `action` runs. */
	chooseDirtyAction(action: string): Promise<DirtyChoice>;
}

export interface Progress {
	/** Reports a stage of a running operation. */
	busy(text: string): void;
	/** Reports the resting status once no operation is running. */
	rest(text: string | undefined): void;
}

export interface MessageDocument {
	/** Materializes `message` and opens it for editing. */
	show(message: string): Promise<void>;
	/** Returns the current text, saving pending edits first. */
	read(): Promise<string>;
	close(): Promise<void>;
}

export interface StateStore<T> {
	load(): T | undefined;
	save(value: T | undefined): Promise<void>;
}

export interface Disposable {
	dispose(): void;
}

import * as path from 'node:path';
import { GitInvocation, GitResult, GitRunner, TextFiles } from '../ports';
import { CommitInspector, ProgressListener, ReviewGit } from './interfaces';
import { COMMIT_FORMAT, parseCommits, parseNameStatus, parseRebaseProgress, parseStatus } from './parsers';
import {
	ChangedFile,
	Commit,
	DefaultBranchHints,
	GitError,
	RebaseOutcome,
	RepositorySnapshot,
	WorkingTreeStatus,
} from './types';

export interface RepositoryPaths {
	readonly root: string;
	readonly gitDir: string;
	readonly rebaseMergeDir: string;
	readonly rebaseApplyDir: string;
	/** Private scratch directory for files the extension materializes. */
	readonly reviewerDir: string;
}

const STASH_MESSAGE = 'branch-reviewer autostash';

/** Prevents git from opening an editor for anything we run. */
const NO_EDITOR = { GIT_EDITOR: 'true' };

export async function discoverPaths(runner: GitRunner): Promise<RepositoryPaths> {
	const result = await runner.run({
		args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'],
	});
	if (result.code !== 0) {
		throw new GitError(['rev-parse'], result.code, result.stderr);
	}
	const [root, gitDir, rebaseMerge, rebaseApply] = result.stdout.split('\n').map(line => line.trim());
	const absolute = (value: string) => path.isAbsolute(value) ? value : path.join(root, value);
	return {
		root,
		gitDir,
		rebaseMergeDir: absolute(rebaseMerge),
		rebaseApplyDir: absolute(rebaseApply),
		reviewerDir: path.join(gitDir, 'branch-reviewer'),
	};
}

/** Single-quotes `value` for the POSIX shell git uses to launch editors. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

abstract class GitCommands {
	constructor(protected readonly runner: GitRunner) {}

	protected async exec(args: readonly string[], options: Omit<GitInvocation, 'args'> = {}): Promise<GitResult> {
		return this.runner.run({ args, ...options });
	}

	/** Runs git and returns stdout, throwing on a non-zero exit. */
	protected async text(args: readonly string[], options: Omit<GitInvocation, 'args'> = {}): Promise<string> {
		const result = await this.exec(args, options);
		if (result.code !== 0) {
			throw new GitError(args, result.code, result.stderr);
		}
		return result.stdout;
	}

	protected async optional(args: readonly string[]): Promise<string | undefined> {
		const result = await this.exec(args);
		return result.code === 0 ? result.stdout.trim() : undefined;
	}
}

export class GitRepository extends GitCommands implements ReviewGit {
	private readonly todoPath: string;

	constructor(runner: GitRunner, private readonly files: TextFiles, private readonly paths: RepositoryPaths) {
		super(runner);
		this.todoPath = path.join(paths.reviewerDir, 'git-rebase-todo');
	}

	async branches(): Promise<string[]> {
		const output = await this.text(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
		return output.split('\n').filter(line => line.length > 0);
	}

	async currentBranch(): Promise<string | undefined> {
		return this.optional(['symbolic-ref', '--quiet', '--short', 'HEAD']);
	}

	async defaultBranchHints(): Promise<DefaultBranchHints> {
		const originHead = await this.optional(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
		const initDefault = await this.optional(['config', '--get', 'init.defaultBranch']);
		return {
			originHead: originHead?.replace(/^origin\//, ''),
			initDefault: initDefault || undefined,
		};
	}

	async resolve(ref: string): Promise<string | undefined> {
		return this.optional(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
	}

	async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
		const result = await this.exec(['merge-base', '--is-ancestor', ancestor, descendant]);
		if (result.code > 1) {
			throw new GitError(['merge-base', '--is-ancestor'], result.code, result.stderr);
		}
		return result.code === 0;
	}

	async commits(base: string, head: string): Promise<Commit[]> {
		return parseCommits(await this.text(['log', '--reverse', '--no-show-signature', `--format=${COMMIT_FORMAT}`, `${base}..${head}`, '--']));
	}

	async hasMerges(base: string, head: string): Promise<boolean> {
		const count = await this.text(['rev-list', '--merges', '--count', `${base}..${head}`, '--']);
		return Number(count.trim()) > 0;
	}

	async snapshot(base: string): Promise<RepositorySnapshot> {
		const merge = await this.files.exists(this.paths.rebaseMergeDir);
		const apply = !merge && await this.files.exists(this.paths.rebaseApplyDir);
		const rebaseDir = merge ? this.paths.rebaseMergeDir : this.paths.rebaseApplyDir;
		const headName = merge || apply ? await this.files.read(path.join(rebaseDir, 'head-name')) : undefined;
		const attached = (await this.exec(['symbolic-ref', '--quiet', 'HEAD'])).code === 0;
		return {
			rebasing: merge || apply,
			rebaseHeadName: headName?.trim(),
			head: await this.resolve('HEAD'),
			attached,
			baseSha: await this.resolve(`refs/heads/${base}`),
		};
	}

	async message(rev: string): Promise<string> {
		return this.text(['log', '-1', '--no-show-signature', '--format=%B', rev, '--']);
	}

	async normalizeMessage(text: string): Promise<string> {
		return this.text(['stripspace', '--strip-comments'], { input: text });
	}

	async startRebase(base: string, head: string, todo: string, onProgress: ProgressListener): Promise<RebaseOutcome> {
		await this.files.write(this.todoPath, todo);
		const args = ['rebase', '--interactive', base, head];
		const result = await this.exec(args, {
			env: { ...NO_EDITOR, GIT_SEQUENCE_EDITOR: `cp ${shellQuote(this.todoPath)}` },
			onStderr: chunk => this.forward(chunk, onProgress),
		});
		return this.outcome(args, result);
	}

	async rewriteTodo(todo: string): Promise<void> {
		await this.files.write(this.todoPath, todo);
		await this.text(['rebase', '--edit-todo'], {
			env: { ...NO_EDITOR, GIT_SEQUENCE_EDITOR: `cp ${shellQuote(this.todoPath)}` },
		});
	}

	async continueRebase(onProgress: ProgressListener): Promise<RebaseOutcome> {
		const args = ['rebase', '--continue'];
		const result = await this.exec(args, { env: NO_EDITOR, onStderr: chunk => this.forward(chunk, onProgress) });
		return this.outcome(args, result);
	}

	async abortRebase(): Promise<void> {
		const result = await this.exec(['rebase', '--abort']);
		if (result.code !== 0 && await this.rebasing()) {
			throw new GitError(['rebase', '--abort'], result.code, result.stderr);
		}
	}

	async amend(message: string): Promise<string> {
		await this.text(['commit', '--amend', '--allow-empty', '--cleanup=strip', '--file=-'], { env: NO_EDITOR, input: message });
		return (await this.text(['rev-parse', 'HEAD'])).trim();
	}

	async fastForward(branch: string, to: string, from: string): Promise<void> {
		await this.text(['update-ref', '-m', 'branch-reviewer: approve', `refs/heads/${branch}`, to, from]);
	}

	async workingTree(): Promise<WorkingTreeStatus> {
		return parseStatus(await this.text(['status', '--porcelain=v1', '-z', '--untracked-files=no']));
	}

	async stash(): Promise<string> {
		await this.text(['stash', 'push', '--message', STASH_MESSAGE]);
		return (await this.text(['rev-parse', 'refs/stash'])).trim();
	}

	async restoreStash(sha: string): Promise<boolean> {
		const entries = (await this.text(['stash', 'list', '--format=%H'])).split('\n');
		const index = entries.indexOf(sha);
		if (index < 0) {
			return false;
		}
		return (await this.exec(['stash', 'pop', `stash@{${index}}`])).code === 0;
	}

	private async rebasing(): Promise<boolean> {
		return await this.files.exists(this.paths.rebaseMergeDir) || await this.files.exists(this.paths.rebaseApplyDir);
	}

	private forward(chunk: string, onProgress: ProgressListener): void {
		const progress = parseRebaseProgress(chunk);
		if (progress) {
			onProgress(progress);
		}
	}

	/**
	 * Classifies how a rebase command ended. Git exits non-zero both for
	 * conflicts and for refusals (such as a dirty tree), so the repository
	 * state is consulted rather than the exit code alone.
	 */
	private async outcome(args: readonly string[], result: GitResult): Promise<RebaseOutcome> {
		if (!await this.rebasing()) {
			if (result.code !== 0) {
				throw new GitError(args, result.code, result.stderr);
			}
			return 'finished';
		}
		if ((await this.workingTree()).unmerged.length > 0) {
			return 'conflict';
		}
		if (result.code !== 0) {
			throw new GitError(args, result.code, result.stderr);
		}
		return 'stopped';
	}
}

export class GitInspector extends GitCommands implements CommitInspector {
	async changedFiles(sha: string): Promise<ChangedFile[]> {
		return parseNameStatus(await this.text(['diff-tree', '--root', '-r', '-M', '--no-commit-id', '--name-status', '-z', sha]));
	}

	async parent(sha: string): Promise<string | undefined> {
		return this.optional(['rev-parse', '--verify', '--quiet', `${sha}^`]);
	}

	async show(rev: string, file: string): Promise<string | undefined> {
		const result = await this.exec(['show', `${rev}:${file}`]);
		return result.code === 0 ? result.stdout : undefined;
	}

	async patch(sha: string, file: string): Promise<string> {
		return this.text(['show', '--format=', '--no-color', '--no-ext-diff', '-U0', sha, '--', file]);
	}
}

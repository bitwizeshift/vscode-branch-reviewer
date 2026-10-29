import { ChangeKind, ChangedFile, Commit, RebaseProgress, WorkingTreeStatus } from './types';

const FIELD = '\x1f';

/** `--format` that pairs with {@link parseCommits}. */
export const COMMIT_FORMAT = `%H${FIELD}%s`;

export function parseCommits(output: string): Commit[] {
	return output
		.split('\n')
		.filter(line => line.length > 0)
		.map(line => {
			const separator = line.indexOf(FIELD);
			return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
		});
}

/**
 * Builds a rebase todo that stops on the first commit and replays the rest.
 * Each review pass edits exactly one commit so that everything after it is
 * re-applied (and conflict-checked) when the pass finishes.
 */
export function buildTodo(commits: readonly Commit[], stopAtFirst: boolean): string {
	return commits
		.map((commit, index) => `${index === 0 && stopAtFirst ? 'edit' : 'pick'} ${commit.sha} ${commit.subject}\n`)
		.join('');
}

const PROGRESS = /Rebasing \((\d+)\/(\d+)\)/g;

/** Returns the latest `Rebasing (n/m)` marker in a chunk of git stderr. */
export function parseRebaseProgress(chunk: string): RebaseProgress | undefined {
	let latest: RebaseProgress | undefined;
	for (const match of chunk.matchAll(PROGRESS)) {
		latest = { current: Number(match[1]), total: Number(match[2]) };
	}
	return latest;
}

const KINDS: Readonly<Record<string, ChangeKind>> = {
	A: 'added',
	C: 'added',
	M: 'modified',
	T: 'modified',
	D: 'deleted',
	R: 'renamed',
};

/** Parses `--name-status -z` output, where renames carry two paths. */
export function parseNameStatus(output: string): ChangedFile[] {
	const fields = output.split('\0');
	const files: ChangedFile[] = [];
	for (let index = 0; index < fields.length;) {
		const status = fields[index++];
		if (status.length === 0) {
			continue;
		}
		const letter = status[0];
		const kind = KINDS[letter] ?? 'modified';
		if (letter === 'R' || letter === 'C') {
			const oldPath = fields[index++];
			const path = fields[index++];
			files.push(letter === 'R' ? { path, kind, oldPath } : { path, kind });
		} else {
			files.push({ path: fields[index++], kind });
		}
	}
	return files;
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Parses `status --porcelain=v1 -z` output. */
export function parseStatus(output: string): WorkingTreeStatus {
	const fields = output.split('\0');
	const unmerged: string[] = [];
	const staged: string[] = [];
	const unstaged: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		const entry = fields[index];
		if (entry.length < 4) {
			continue;
		}
		const code = entry.slice(0, 2);
		const path = entry.slice(3);
		if (code[0] === 'R' || code[0] === 'C') {
			index++; // the original path follows a rename or copy
		}
		if (code === '??' || code === '!!') {
			continue;
		}
		if (UNMERGED.has(code)) {
			unmerged.push(path);
			continue;
		}
		if (code[0] !== ' ') {
			staged.push(path);
		}
		if (code[1] !== ' ') {
			unstaged.push(path);
		}
	}
	return { unmerged, staged, unstaged };
}

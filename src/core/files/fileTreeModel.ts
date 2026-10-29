import { ChangeKind, ChangedFile } from '../git/types';

export interface DirectoryEntry {
	readonly name: string;
	readonly directory: boolean;
}

export interface TreeNode {
	/** Repository-relative path using `/` separators. */
	readonly path: string;
	readonly name: string;
	readonly directory: boolean;
	readonly change?: ChangeKind;
	/** Present only in the parent commit, so it cannot be opened from disk. */
	readonly deleted: boolean;
}

const HIDDEN = new Set(['.git']);

const join = (directory: string, name: string) => directory ? `${directory}/${name}` : name;

/** Change kinds of a commit, indexed for per-folder lookups. */
export class ChangeIndex {
	private readonly files = new Map<string, ChangeKind>();
	private readonly folders = new Map<string, Set<ChangeKind>>();

	constructor(changes: readonly ChangedFile[]) {
		for (const change of changes) {
			this.files.set(change.path, change.kind);
			const segments = change.path.split('/');
			for (let depth = 1; depth < segments.length; depth++) {
				const folder = segments.slice(0, depth).join('/');
				const kinds = this.folders.get(folder) ?? new Set<ChangeKind>();
				kinds.add(change.kind);
				this.folders.set(folder, kinds);
			}
		}
	}

	get size(): number {
		return this.files.size;
	}

	isChangedFile(path: string): boolean {
		return this.files.has(path);
	}

	/** Kind of a file, or of a folder summarised from everything beneath it. */
	kindOf(path: string): ChangeKind | undefined {
		const file = this.files.get(path);
		if (file) {
			return file;
		}
		const kinds = this.folders.get(path);
		if (!kinds) {
			return undefined;
		}
		if (kinds.size === 1) {
			const [only] = kinds;
			return only === 'renamed' ? 'modified' : only;
		}
		return 'modified';
	}

	/** Immediate children of `directory` that some change passes through. */
	childrenOf(directory: string): DirectoryEntry[] {
		const prefix = directory ? `${directory}/` : '';
		const children = new Map<string, boolean>();
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix)) {
				continue;
			}
			const rest = path.slice(prefix.length);
			const separator = rest.indexOf('/');
			const name = separator < 0 ? rest : rest.slice(0, separator);
			children.set(name, (children.get(name) ?? false) || separator >= 0);
		}
		return [...children].map(([name, directory]) => ({ name, directory }));
	}
}

/**
 * Lists the children of `directory` the way the Explorer would, adding
 * entries that only exist in the parent commit (deleted files) and, when
 * `changedOnly` is set, keeping only paths the commit touched.
 */
export function childNodes(directory: string, entries: readonly DirectoryEntry[], index: ChangeIndex, changedOnly: boolean): TreeNode[] {
	const nodes = new Map<string, TreeNode>();
	for (const entry of entries) {
		if (HIDDEN.has(entry.name)) {
			continue;
		}
		const path = join(directory, entry.name);
		nodes.set(entry.name, { path, name: entry.name, directory: entry.directory, change: index.kindOf(path), deleted: false });
	}
	for (const entry of index.childrenOf(directory)) {
		if (nodes.has(entry.name)) {
			continue;
		}
		const path = join(directory, entry.name);
		nodes.set(entry.name, { path, name: entry.name, directory: entry.directory, change: index.kindOf(path), deleted: true });
	}
	return [...nodes.values()]
		.filter(node => !changedOnly || node.change !== undefined)
		.sort((left, right) => left.directory === right.directory
			? left.name.localeCompare(right.name)
			: left.directory ? -1 : 1);
}

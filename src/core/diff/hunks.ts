export interface LineRange {
	/** Zero-based, inclusive. */
	readonly start: number;
	readonly end: number;
}

export interface LineChanges {
	readonly added: readonly LineRange[];
	readonly modified: readonly LineRange[];
	/** Zero-based lines after which content was removed. */
	readonly deleted: readonly number[];
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Classifies the new-side lines of a zero-context (`-U0`) patch. */
export function parseLineChanges(patch: string): LineChanges {
	const added: LineRange[] = [];
	const modified: LineRange[] = [];
	const deleted: number[] = [];
	for (const line of patch.split('\n')) {
		const match = HUNK.exec(line);
		if (!match) {
			continue;
		}
		const oldCount = match[1] === undefined ? 1 : Number(match[1]);
		const newStart = Number(match[2]);
		const newCount = match[3] === undefined ? 1 : Number(match[3]);
		if (newCount === 0) {
			// For pure deletions git reports the line preceding the removal.
			deleted.push(Math.max(newStart - 1, 0));
			continue;
		}
		const range = { start: newStart - 1, end: newStart + newCount - 2 };
		(oldCount === 0 ? added : modified).push(range);
	}
	return { added, modified, deleted };
}

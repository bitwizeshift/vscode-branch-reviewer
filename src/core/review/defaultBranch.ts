import { DefaultBranchHints } from '../git/types';

const CONVENTIONAL = ['main', 'master'];

/** Picks the repository's default branch among the local `branches`. */
export function defaultBase(branches: readonly string[], hints: DefaultBranchHints, current: string | undefined): string | undefined {
	const candidates = [hints.originHead, hints.initDefault, ...CONVENTIONAL];
	return candidates.find(name => name !== undefined && branches.includes(name))
		?? branches.find(name => name !== current)
		?? branches[0];
}

export function defaultHead(branches: readonly string[], base: string | undefined, current: string | undefined): string | undefined {
	if (current !== undefined && branches.includes(current)) {
		return current;
	}
	return branches.find(name => name !== base) ?? branches[0];
}

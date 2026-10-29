import * as path from 'node:path';
import * as vscode from 'vscode';

/** Marks URIs produced by the Files Changed view so only they are decorated. */
export const REVIEW_QUERY = 'branch-reviewer';

/** Repository-relative `/` path of `uri`, or undefined outside `root`. */
export function relativePath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
	if (uri.scheme !== 'file') {
		return undefined;
	}
	const relative = path.relative(root.fsPath, uri.fsPath);
	if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
		return undefined;
	}
	return relative.split(path.sep).join('/');
}

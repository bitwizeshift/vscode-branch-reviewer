import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Integration tests run against a throwaway repository opened as the
// workspace; each test rebuilds its history from scratch.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'branch-reviewer-')));
const git = (...args) => execFileSync('git', args, { cwd: fixture });
git('init', '--quiet', '--initial-branch=main');
git('config', 'user.name', 'Branch Reviewer Tests');
git('config', 'user.email', 'tests@example.invalid');
git('config', 'commit.gpgsign', 'false');
git('commit', '--quiet', '--allow-empty', '--message', 'Root');

export default defineConfig({
	files: 'out/test/integration/**/*.test.js',
	workspaceFolder: fixture,
	env: { BRANCH_REVIEWER_FIXTURE: fixture },
	launchArgs: ['--disable-extensions'],
	mocha: { ui: 'tdd', timeout: 20000 },
	// Reuse a local VS Code instead of downloading one when a path is given.
	useInstallation: process.env.VSCODE_EXECUTABLE_PATH
		? { fromPath: process.env.VSCODE_EXECUTABLE_PATH }
		: undefined,
});

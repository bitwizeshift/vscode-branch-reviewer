import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Integration tests run against a throwaway repository opened as the
// workspace; each test rebuilds its history from scratch.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'branch-reviewer-')));
const git = (...args) => execFileSync('git', args, { cwd: fixture });
git('init', '--quiet', '--initial-branch=main');
git('config', 'user.name', 'Branch Reviewer Tests');
git('config', 'user.email', 'tests@example.invalid');
// Approval signs commits, so a stand-in gpg produces placeholder
// signatures without needing a real key.
const gpg = `${fixture}-gpg.sh`;
writeFileSync(gpg, [
	'#!/bin/sh',
	'cat > /dev/null',
	"printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 FAKE\\n' >&2",
	"printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'",
	'',
].join('\n'));
chmodSync(gpg, 0o755);
git('config', 'gpg.program', gpg);
git('config', 'commit.gpgsign', 'true');
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

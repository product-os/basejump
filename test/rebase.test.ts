import {
	describe,
	beforeEach,
	afterEach,
	beforeAll,
	afterAll,
	test,
	expect,
	vi,
} from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import type { SimpleGit } from 'simple-git';
import { simpleGit } from 'simple-git';

import rebase from '../src/rebase.js';
import { CodeConflictError, RemoteChangedError } from '../src/errors.js';

// Create a "remote" repo with an initial commit
async function setupRemote(tmpDir: string) {
	const remoteRepoPath = path.join(tmpDir, 'test.git');
	const localRepoPath = path.join(tmpDir, 'test');
	await fs.mkdir(remoteRepoPath, { recursive: true });
	await fs.mkdir(localRepoPath, { recursive: true });

	// Create a bare git repo
	const remoteGit = simpleGit(remoteRepoPath);
	await remoteGit.init(true, ['--initial-branch=main']);

	// Create an initial commit using local repo (as it's easier than creating one directly in a bare repo)
	const localGit = simpleGit(localRepoPath);
	await localGit.clone(remoteRepoPath, localRepoPath);
	await createCommit({ repoPath: localRepoPath, filename: '0' });
	await localGit.push('origin', 'main');

	// Sanity check that remote and local both have the same one commit
	expect(await listCommits(localGit, 'main')).toEqual(
		await listCommits(remoteGit, 'main'),
	);

	return { localGit, localRepoPath, remoteGit, remoteRepoPath };
}

// Create a commit which adds a file to the repo on a given branch
async function createCommit({
	repoPath,
	filename,
	content = 'test',
	branch,
}: {
	repoPath: string;
	filename: string;
	content?: string;
	branch?: string;
}) {
	const git = simpleGit(repoPath);
	if (branch) {
		await git.checkout(branch);
	}
	await fs.writeFile(path.join(repoPath, filename), content);
	await git.add([filename]);
	await git.commit(`Add ${filename}`);
}

async function listCommits(git: SimpleGit, branch: string) {
	return (await git.raw(['log', '--oneline', branch]))
		.split('\n')
		.filter((line) => line.trim() !== '');
}

describe('git rebase', () => {
	let tempDir: string;
	// TODO: This is unnecessary if we run tests in Docker
	let priorGitIdentity: { name: string; email: string };

	// Set global git identity for GH actions test env
	beforeAll(async () => {
		// TODO: Storing prior git identity is unnecessary if we run tests in Docker
		// It's only necessary to prevent overwriting global identity in dev environments
		priorGitIdentity = {
			name: (await simpleGit().raw('config', '--global', 'user.name')).trim(),
			email: (await simpleGit().raw('config', '--global', 'user.email')).trim(),
		};

		// Set git identity for tests
		await simpleGit().raw(
			'config',
			'--global',
			'user.name',
			'Basejump Bot (Global)',
		);
		await simpleGit().raw(
			'config',
			'--global',
			'user.email',
			'basejump.global@balena.io',
		);
	});

	// Restore git identity after tests
	// TODO: This resetting of git global identity is unnecessary if we run tests in Docker
	afterAll(async () => {
		await simpleGit().raw(
			'config',
			'--global',
			'user.name',
			priorGitIdentity.name,
		);
		await simpleGit().raw(
			'config',
			'--global',
			'user.email',
			priorGitIdentity.email,
		);
	});

	beforeEach(async () => {
		// Setup up different temp test directory per assertion to avoid conflicts
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebase-test-'));
	});

	afterEach(async () => {
		// Clean up test artifacts and restore mocks
		vi.restoreAllMocks();
		await fs.rm(tempDir, { recursive: true });
	});

	test('should rebase feature branch with one commit onto main', async () => {
		const { localGit, localRepoPath, remoteGit, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create another commit on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await localGit.push('origin', 'main');

		// Create a feature branch from one commit older than main
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');

		// Create a commit on feature branch
		await createCommit({
			repoPath: localRepoPath,
			filename: '2',
			branch: feat,
		});
		await localGit.push('origin', feat);

		// Sanity check that:
		// - main has 2 commits, 'Add 0' and 'Add 1'
		// - feature branch has 2 commits, 'Add 0' and 'Add 2'
		const [m1, m0] = await listCommits(remoteGit, 'main');
		const [f2, f0] = await listCommits(remoteGit, feat);
		// Both main and feat should have the same initial commit
		expect(m0).toEqual(f0);
		// However, the 2nd commits should differ
		expect(m1).not.toEqual(f2);
		expect(m0).toMatch(/Add 0/);
		expect(m1).toMatch(/Add 1/);
		expect(f2).toMatch(/Add 2/);

		// Rebase the feature branch onto main
		await rebase(remoteRepoPath, feat, 'main', []);

		// Assert that:
		// - feature branch has 3 commits, 'Add 0', 'Add 1', and 'Add 2'
		// - main branch has same 2 commits as before, 'Add 0' and 'Add 1'
		const mainCommits = await listCommits(remoteGit, 'main');
		const featCommits = await listCommits(remoteGit, feat);
		// Because of the rebase, the feature commit's sha would have changed
		expect(featCommits[0]).not.toEqual(f2);
		// Otherwise, no other commits should have changed
		expect(mainCommits).toEqual([m1, m0]);
		expect(featCommits).toEqual([featCommits[0], m1, m0]);
	});

	test('should rebase feature branch with multiple commits onto main', async () => {
		const { localGit, localRepoPath, remoteGit, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create three commits on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await createCommit({ repoPath: localRepoPath, filename: '2' });
		await createCommit({ repoPath: localRepoPath, filename: '3' });
		await localGit.push('origin', 'main');

		// Create a feature branch from initial commit of main (3 commits back)
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main~3');

		// Create three commits on feature branch
		await createCommit({
			repoPath: localRepoPath,
			filename: '4',
			branch: feat,
		});
		await createCommit({
			repoPath: localRepoPath,
			filename: '5',
			branch: feat,
		});
		await createCommit({
			repoPath: localRepoPath,
			filename: '6',
			branch: feat,
		});
		await localGit.push('origin', feat);

		// Sanity check that:
		// - main has 4 commits, 'Add 0', 'Add 1', 'Add 2', and 'Add 3'
		// - feature branch has 4 commits, 'Add 0', 'Add 4', 'Add 5', and 'Add 6'
		const [m3, m2, m1, m0] = await listCommits(remoteGit, 'main');
		const [f6, f5, f4, f0] = await listCommits(remoteGit, feat);
		// Both main and feat should have the same initial commit
		expect(m0).toEqual(f0);
		// All other commits should be different
		expect(m1).toMatch(/Add 1/);
		expect(m2).toMatch(/Add 2/);
		expect(m3).toMatch(/Add 3/);
		expect(f4).toMatch(/Add 4/);
		expect(f5).toMatch(/Add 5/);
		expect(f6).toMatch(/Add 6/);

		// Rebase the feature branch onto main
		await rebase(remoteRepoPath, feat, 'main', []);

		// Assert that:
		// - feature branch has 7 commits
		// - main branch has same 4 commits as before, 'Add 0', 'Add 1', 'Add 2', and 'Add 3'
		const mainCommits = await listCommits(remoteGit, 'main');
		const featCommits = await listCommits(remoteGit, feat);
		// Because of the rebase, the feature commit's shas would have changed
		expect(featCommits[0]).not.toEqual(f6);
		expect(featCommits[1]).not.toEqual(f5);
		expect(featCommits[2]).not.toEqual(f4);
		// Otherwise, no other commits should have changed
		expect(mainCommits).toEqual([m3, m2, m1, m0]);
		expect(featCommits).toEqual([
			featCommits[0],
			featCommits[1],
			featCommits[2],
			m3,
			m2,
			m1,
			m0,
		]);
	});

	test('should throw CodeConflictError with the conflicting commit sha if there are conflicts during rebase', async () => {
		const { localGit, localRepoPath, remoteGit, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a commit on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await localGit.push('origin', 'main');

		// Create a feature branch from initial commit of main
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');

		// Create a commit on feature branch that conflicts with main
		await createCommit({
			repoPath: localRepoPath,
			filename: '1',
			branch: feat,
			content: 'conflict',
		});
		await localGit.push('origin', feat);

		// Sanity check that:
		// - main has 2 commits, 'Add 0' and 'Add 1'
		// - feature branch has 2 commits, 'Add 0' and 'Add 1'
		const [m1, m0] = await listCommits(remoteGit, 'main');
		const [f1, f0] = await listCommits(remoteGit, feat);
		// Both main and feat should have the same initial commit
		expect(m0).toEqual(f0);
		// However, the 2nd commits should differ
		expect(m1).not.toEqual(f1);
		expect(m0).toMatch(/Add 0/);
		expect(m1).toMatch(/Add 1/);
		expect(f1).toMatch(/Add 1/);

		// Rebase the feature branch onto main
		// Assert that the conflict sha in the CodeConflictError is the same as the conflict sha in the rebase error
		try {
			await rebase(remoteRepoPath, feat, 'main', []);
			expect.fail('Expected rebase to throw CodeConflictError');
		} catch (error: any) {
			expect(error).toBeInstanceOf(CodeConflictError);
			// Assert the first 7 chars of the commit sha only,
			// as that's all that's necessary to identify the conflicting commit
			expect(error.commitSha.substring(0, 7)).toEqual(f1.substring(0, 7));
			expect(error.message).toMatch(/CONFLICT/);
		}
	});

	test('should throw CodeConflictError for add/add conflict', async () => {
		const { localGit, localRepoPath, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a commit on main that adds a new file
		await createCommit({
			repoPath: localRepoPath,
			filename: 'conflict.txt',
			content: 'main content',
		});
		await localGit.push('origin', 'main');

		// Create a feature branch from initial commit of main
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');

		// Create a commit on feature branch that adds the same file with different content
		await createCommit({
			repoPath: localRepoPath,
			filename: 'conflict.txt',
			branch: feat,
			content: 'feature content',
		});
		await localGit.push('origin', feat);

		// Attempt to rebase should throw CodeConflictError
		try {
			await rebase(remoteRepoPath, feat, 'main', []);
			expect.fail('Expected rebase to throw CodeConflictError');
		} catch (error: any) {
			expect(error).toBeInstanceOf(CodeConflictError);
			expect(error.message.includes('CONFLICT (add/add)')).toBe(true);
		}
	});

	test('should throw CodeConflictError for modify/delete conflict', async () => {
		const { localGit, localRepoPath, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a shared file in both branches
		await createCommit({
			repoPath: localRepoPath,
			filename: 'shared.txt',
			content: 'original content',
		});
		await localGit.push('origin', 'main');

		// Create a feature branch from main
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main');

		// On main: modify the file
		await localGit.checkout('main');
		await createCommit({
			repoPath: localRepoPath,
			filename: 'shared.txt',
			content: 'modified content',
		});
		await localGit.push('origin', 'main');

		// On feature: delete the file
		await localGit.checkout(feat);
		await fs.rm(path.join(localRepoPath, 'shared.txt'));
		await localGit.add(['-A']);
		await localGit.commit('Delete shared.txt');
		await localGit.push('origin', feat);

		// Attempt to rebase should throw CodeConflictError
		try {
			await rebase(remoteRepoPath, feat, 'main', []);
			expect.fail('Expected rebase to throw CodeConflictError');
		} catch (error: any) {
			expect(error).toBeInstanceOf(CodeConflictError);
			expect(error.message.includes('CONFLICT (modify/delete)')).toBe(true);
		}
	});

	test('should throw CodeConflictError for rename/rename conflict', async () => {
		const { localGit, localRepoPath, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a shared file in both branches
		await createCommit({
			repoPath: localRepoPath,
			filename: 'original.txt',
			content: 'content',
		});
		await localGit.push('origin', 'main');

		// Create a feature branch from main
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main');

		// On main: rename the file to one name
		await localGit.checkout('main');
		await localGit.mv('original.txt', 'renamed-main.txt');
		await localGit.commit('Rename to renamed-main.txt');
		await localGit.push('origin', 'main');

		// On feature: rename the file to a different name
		await localGit.checkout(feat);
		await localGit.mv('original.txt', 'renamed-feature.txt');
		await localGit.commit('Rename to renamed-feature.txt');
		await localGit.push('origin', feat);

		// Attempt to rebase should throw CodeConflictError
		try {
			await rebase(remoteRepoPath, feat, 'main', []);
			expect.fail('Expected rebase to throw CodeConflictError');
		} catch (error: any) {
			expect(error).toBeInstanceOf(CodeConflictError);
			expect(error.message.includes('CONFLICT (rename/rename)')).toBe(true);
		}
	});

	test('should handle case where no rebase is necessary', async () => {
		const { localGit, remoteGit, remoteRepoPath } = await setupRemote(tempDir);

		// Create a feature branch from main (both are at the same commit)
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main');
		await localGit.push('origin', feat);

		// Sanity check that both branches have the same commit
		const mainCommits = await listCommits(remoteGit, 'main');
		const featCommits = await listCommits(remoteGit, feat);
		expect(mainCommits).toEqual(featCommits);

		// Rebase should complete successfully without doing anything
		await rebase(remoteRepoPath, feat, 'main', []);

		// Both branches should still have the same commits
		const mainCommitsAfter = await listCommits(remoteGit, 'main');
		const featCommitsAfter = await listCommits(remoteGit, feat);
		expect(mainCommitsAfter).toEqual(mainCommits);
		expect(featCommitsAfter).toEqual(featCommits);
	});

	// TODO: This test relies on a race condition where the timing is hard to nail.
	// Rebase clones, checks out, rebases, and pushes in the same function, so there's a tiny window between
	// checkout and rebase in which we can push a change to the remote to trigger a remote changed error.
	// We don't want to modify the rebase function to add a delay, as modifying functionality for tests is
	// a bad practice. While the functionality described here has been tested to work manually,
	// this test case requires more thought into its design to make sure it passes reliably.
	test.todo(
		'should throw error when pushing with --force-with-lease fails due to remote branch update',
		async () => {
			const { localGit, localRepoPath, remoteRepoPath } =
				await setupRemote(tempDir);

			// Mock git rebase to wait 2 seconds before rebasing
			// TODO: this doesn't actually get called, so the rebase function doesn't wait 2 seconds.
			vi.mock('simple-git', async (importOriginal: any) => {
				const actual = await importOriginal();
				return {
					...actual,
					rebase: vi.fn().mockImplementation(async (...args) => {
						await setTimeout(2000);
						return actual.rebase(...args);
					}),
				};
			});

			// Create a commit on main
			await createCommit({ repoPath: localRepoPath, filename: '1' });
			await localGit.push('origin', 'main');

			// Create a feature branch from initial commit
			const feat = 'feature';
			await localGit.checkoutBranch(feat, 'main^');

			// Create a commit on feature branch
			await createCommit({
				repoPath: localRepoPath,
				filename: '2',
				branch: feat,
			});
			await localGit.push('origin', feat);

			// Attempt rebase which should wait 2 seconds before rebasing, which
			// gives this test process time to update the remote branch between rebase & push
			const updateRemote = async () => {
				await createCommit({
					repoPath: localRepoPath,
					filename: '3',
					branch: feat,
				});
				await localGit.push('origin', feat);
			};
			try {
				await Promise.all([
					updateRemote(),
					rebase(remoteRepoPath, feat, 'main', []),
				]);
				expect.fail(
					'Expected rebase to throw error due to force-with-lease failure',
				);
			} catch (error: any) {
				expect(error).toBeInstanceOf(RemoteChangedError);
			}
		},
	);

	test('should drop merge commits (default git behavior)', async () => {
		const { localGit, localRepoPath, remoteGit, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a commit on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await localGit.push('origin', 'main');

		// Create a feature branch from initial commit
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');

		// Create a commit on feature branch
		await createCommit({
			repoPath: localRepoPath,
			filename: '2',
			branch: feat,
		});

		// Create a side branch from feature branch
		const sideBranch = 'side-branch';
		await localGit.checkoutBranch(sideBranch, feat);
		await createCommit({
			repoPath: localRepoPath,
			filename: '3',
			branch: sideBranch,
		});

		// Switch back to feature branch and merge the side branch (creating a merge commit)
		await localGit.checkout(feat);
		await localGit.merge([
			sideBranch,
			'--no-ff',
			'-m',
			'Merge side-branch into feature',
		]);

		// Push feature branch
		await localGit.push('origin', feat);

		// Sanity check: feature branch should have a merge commit
		const featCommitsBefore = await listCommits(remoteGit, feat);
		const mergeCommit = featCommitsBefore.find((commit) =>
			commit.includes('Merge side-branch'),
		);
		expect(mergeCommit).toBeDefined();

		// Rebase feature branch onto main
		await rebase(remoteRepoPath, feat, 'main', []);

		// Assert that merge commit is dropped
		const featCommitsAfter = await listCommits(remoteGit, feat);
		const mergeCommitAfter = featCommitsAfter.find((commit) =>
			commit.includes('Merge side-branch'),
		);
		expect(mergeCommitAfter).toBeUndefined();

		// Assert that feature branch has been rebased onto main with individual commits
		const mainCommits = await listCommits(remoteGit, 'main');
		// Feature branch should have main's commits plus the two individual commits (merge commit dropped)
		expect(featCommitsAfter.length).toBe(mainCommits.length + 2); // +2 for the two individual commits from both branches
	});

	test('should skip commits that were already cherry-picked to base branch (default git behavior)', async () => {
		const { localGit, localRepoPath, remoteGit, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a feature branch from initial commit
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main');

		// Create two commits on feature branch
		await createCommit({
			repoPath: localRepoPath,
			filename: '1',
			branch: feat,
			content: 'feature content 1',
		});
		await createCommit({
			repoPath: localRepoPath,
			filename: '2',
			branch: feat,
			content: 'feature content 2',
		});
		await localGit.push('origin', feat);

		// Get the commit SHAs from feature branch
		const featCommitsBefore = await listCommits(remoteGit, feat);
		const [_feat2, feat1, _initial] = featCommitsBefore;

		// Switch to main and cherry-pick the first commit from feature branch
		await localGit.checkout('main');
		await localGit.raw(['cherry-pick', feat1.split(' ')[0]]);

		// Add another commit on main
		await createCommit({
			repoPath: localRepoPath,
			filename: '3',
			content: 'main content',
		});
		await localGit.push('origin', 'main');

		// Sanity check: main should have 3 commits (initial + cherry-picked + new)
		const mainCommitsBefore = await listCommits(remoteGit, 'main');
		expect(mainCommitsBefore.length).toBe(3);

		// One of main's commits should have the same content as the cherry-picked commit
		const cherryPickedCommit = mainCommitsBefore.find((commit) =>
			commit.includes('Add 1'),
		);
		expect(cherryPickedCommit).toBeDefined();

		// Rebase feature branch onto main
		await rebase(remoteRepoPath, feat, 'main', []);

		// Assert that the cherry-picked commit is skipped during rebase
		const featCommitsAfter = await listCommits(remoteGit, feat);
		const mainCommitsAfter = await listCommits(remoteGit, 'main');

		// Feature branch should have: main's commits + only the non-cherry-picked commit
		expect(featCommitsAfter.length).toBe(mainCommitsAfter.length + 1);

		// The cherry-picked commit should not appear twice
		const feat1Commits = featCommitsAfter.filter((commit) =>
			commit.includes('Add 1'),
		);
		expect(feat1Commits.length).toBe(1); // Only the original from main, not duplicated

		// The non-cherry-picked commit should still be present
		const feat2Commits = featCommitsAfter.filter((commit) =>
			commit.includes('Add 2'),
		);
		expect(feat2Commits.length).toBe(1);
	});

	test('should keep empty commits that intentionally start as empty using --allow-empty (default git behavior)', async () => {
		const { localGit, localRepoPath, remoteGit, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a commit on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await localGit.push('origin', 'main');

		// Create a feature branch from initial commit
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');

		// Create a normal commit on feature branch
		await createCommit({
			repoPath: localRepoPath,
			filename: '2',
			branch: feat,
		});

		// Create an empty commit on feature branch (intentionally empty)
		await localGit.commit('Empty commit for testing', ['--allow-empty']);

		// Create another normal commit on feature branch
		await createCommit({
			repoPath: localRepoPath,
			filename: '3',
			branch: feat,
		});

		// Push feature branch
		await localGit.push('origin', feat);

		// Sanity check: feature branch should have 4 commits (initial + 2 normal + 1 empty)
		const featCommitsBefore = await listCommits(remoteGit, feat);
		expect(featCommitsBefore.length).toBe(4);

		// Verify empty commit exists
		const emptyCommit = featCommitsBefore.find((commit) =>
			commit.includes('Empty commit for testing'),
		);
		expect(emptyCommit).toBeDefined();

		// Rebase feature branch onto main
		await rebase(remoteRepoPath, feat, 'main', []);

		// Assert that intentionally empty commit is preserved during rebase
		const featCommitsAfter = await listCommits(remoteGit, feat);
		const emptyCommitAfter = featCommitsAfter.find((commit) =>
			commit.includes('Empty commit for testing'),
		);
		expect(emptyCommitAfter).toBeDefined();

		// Assert that all commits are preserved
		const mainCommits = await listCommits(remoteGit, 'main');
		// Feature branch should have: main's commits + 3 commits (2 normal + 1 intentionally empty)
		expect(featCommitsAfter.length).toBe(mainCommits.length + 3);

		// Verify the non-empty commits are still present
		const normalCommit1 = featCommitsAfter.find((commit) =>
			commit.includes('Add 2'),
		);
		const normalCommit2 = featCommitsAfter.find((commit) =>
			commit.includes('Add 3'),
		);
		expect(normalCommit1).toBeDefined();
		expect(normalCommit2).toBeDefined();
	});

	test('should clean up working directory on rebase success', async () => {
		const { localGit, localRepoPath, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a commit on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await localGit.push('origin', 'main');

		// Create a feature branch from initial commit
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');
		await createCommit({
			repoPath: localRepoPath,
			filename: '2',
			branch: feat,
		});
		await localGit.push('origin', feat);

		// Get working dir state before rebase
		const workingDirBefore = await fs.readdir(os.tmpdir());

		// Perform rebase (should succeed)
		await rebase(remoteRepoPath, feat, 'main', []);

		// Assert that working directory was cleaned up
		expect(await fs.readdir(os.tmpdir())).toEqual(workingDirBefore);
	});

	test('should clean up working directory on rebase error', async () => {
		const { localGit, localRepoPath, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a commit on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await localGit.push('origin', 'main');

		// Create a feature branch that will cause a conflict
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');
		await createCommit({
			repoPath: localRepoPath,
			filename: '1',
			branch: feat,
			content: 'conflicting content',
		});
		await localGit.push('origin', feat);

		// Get working dir state before rebase
		const workingDirBefore = await fs.readdir(os.tmpdir());

		// Perform rebase (should fail with conflict)
		try {
			await rebase(remoteRepoPath, feat, 'main', []);
			expect.fail('Expected rebase to throw CodeConflictError');
		} catch (error: any) {
			expect(error).toBeInstanceOf(CodeConflictError);
		}

		// Assert that working directory was cleaned up even on error
		expect(await fs.readdir(os.tmpdir())).toEqual(workingDirBefore);
	});

	// GPG options are passed through git config, so this tests that configs are applied for rebase
	test('should apply git config options during rebase', async () => {
		const { localGit, localRepoPath, remoteGit, remoteRepoPath } =
			await setupRemote(tempDir);

		// Create a commit on main
		await createCommit({ repoPath: localRepoPath, filename: '1' });
		await localGit.push('origin', 'main');

		// Create a feature branch from initial commit
		const feat = 'feature';
		await localGit.checkoutBranch(feat, 'main^');
		await createCommit({
			repoPath: localRepoPath,
			filename: '2',
			branch: feat,
		});
		await localGit.push('origin', feat);

		// Define git config with user.name and user.email
		const gitConfig = [
			`committer.name=${process.env.GIT_COMMITTER_NAME}`,
			`committer.email=${process.env.GIT_COMMITTER_EMAIL}`,
		];

		// Perform rebase with git config
		await rebase(remoteRepoPath, feat, 'main', gitConfig);

		// Fetch latest from remote feature branch and verify committer
		// See: https://git-scm.com/docs/git-log
		const featCommits = await remoteGit.log([
			feat,
			'--format=%h %s / Committer: %cn <%ce>',
		]);
		const commits = featCommits.latest?.hash.split('\n');
		expect(commits).toHaveLength(3);
		expect(commits![0]).toMatch(
			/^[a-f0-9]{7} Add 2 \/ Committer: Basejump Test Bot <basejump-test@balena.io>/,
		);
	});

	// TODO: this is hard to set up as it requires a test GPG key be created for testing
	// and revoked after testing, and should be done in a containerized environment in case
	// the test env does not have GPG installed.
	test.todo(
		'should sign commits if commit.gpgsign=true and user.signingkey is set',
	);
});

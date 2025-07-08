import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import type { Logger } from 'pino';

import { CodeConflictError, RemoteChangedError } from './errors.js';

/**
 * Performs a git rebase operation
 * @param remoteUri - URI to clone the repository from, e.g. `https://github.com/owner/repo.git`
 * @param featBranch - Branch to be rebased, e.g. `feature`
 * @param baseBranch - Branch to rebase onto, e.g. `main`
 * @returns Promise that resolves when rebase is complete
 */
export default async function run(
	remoteUri: string,
	featBranch: string,
	baseBranch: string,
	logger?: Logger,
): Promise<void> {
	// Create a temp dir to clone the repo into
	const workingDir = await mkdtemp(join(tmpdir(), `basejump-${Date.now()}-`));

	// Initialize a git client with working dir as the base dir
	const git = simpleGit(workingDir);

	try {
		// Since rebase is triggered by a GitHub issue comment event on a PR
		// of an existing remote repo, it is assumed that the repo and the branch
		// on which the issue comment was created both exist. Therefore, neither
		// clone nor checkout are expected to fail. Although there is a chance
		// that the remote feature branch is deleted right after the rebase is
		// triggered but before the checkout is performed, this is extremely unlikely.
		logger?.debug(`Cloning ${remoteUri}`);
		await git.clone(remoteUri, workingDir);
		logger?.debug(`Checking out ${featBranch}`);
		await git.checkout(featBranch);

		logger?.debug(`Rebasing ${featBranch} onto ${baseBranch}`);
		const wasRebased = await doRebase(git, baseBranch);

		// Only modify remote if rebase was performed
		if (wasRebased) {
			logger?.debug(`Pushing ${featBranch} to origin`);
			await forcePushWithLease(git, featBranch);
		}
	} finally {
		// Remove the working directory
		await rm(workingDir, { recursive: true });
	}
}

/**
 * Rebase the current branch onto the base branch
 * @param git - The git client
 * @param baseBranch - The base branch to rebase onto
 * @returns boolean indicating whether a rebase was performed
 * @throws CodeConflictError if a conflict is detected during rebase
 */
async function doRebase(git: SimpleGit, baseBranch: string): Promise<boolean> {
	// Rebase onto base branch
	try {
		const message = await git.rebase([baseBranch]);
		if (message.match(/^Current branch .* is up to date/)) {
			return false;
		}
		return true;
	} catch (error: unknown) {
		// The error from git is a conflict error if its message contains `CONFLICT`
		if (error instanceof Error && error.message.includes('CONFLICT')) {
			// Get the commit sha of the conflict
			const conflictCommitSha = await git.revparse('REBASE_HEAD');
			throw new CodeConflictError(error.message, conflictCommitSha);
		}
		throw error;
	}
}

async function forcePushWithLease(git: SimpleGit, branch: string) {
	try {
		await git.push('origin', branch, ['--force-with-lease']);
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			error.message.includes('[rejected] (stale info)')
		) {
			throw new RemoteChangedError(error.message);
		}
	}
}

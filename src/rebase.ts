import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import type { Logger } from 'pino';

import { CodeConflictError, RemoteChangedError } from './errors.ts';

/**
 * Performs a git rebase operation
 * @param remoteUri - URI to clone the repository from, e.g. `https://github.com/owner/repo.git`
 * @param featBranch - Branch to be rebased, e.g. `feature`
 * @param featHeadSha - Commit sha the branch to be rebased is expected to be at
 * @param baseBranch - Branch to rebase onto, e.g. `main`
 * @param gitConfig - Git config to use when initializing git client
 * @param logger - Logger instance
 * @returns Promise that resolves when rebase is complete
 */
export default async function run(
	remoteUri: string,
	featBranch: string,
	featHeadSha: string,
	baseBranch: string,
	gitConfig: string[],
	logger?: Logger,
): Promise<void> {
	// Create a temp dir to clone the repo into
	const workingDir = await mkdtemp(join(tmpdir(), `basejump-${Date.now()}-`));

	// Initialize a git client with provided git config
	const git = simpleGit(workingDir, {
		config: gitConfig,
	});

	try {
		// Since rebase is triggered by a GitHub issue comment event on a PR
		// of an existing remote repo, it is assumed that the repo and the branch
		// on which the issue comment was created both exist. Therefore, neither
		// clone nor checkout are expected to fail. Although there is a chance
		// that the remote feature branch is deleted right after the rebase is
		// triggered but before the checkout is performed, this is extremely unlikely.
		logger?.debug(
			// Remove the credentials from the remote URI for logging
			`Cloning ${remoteUri.replace(/^https:\/\/[^@/]*@/, 'https://')}`,
		);
		await git.clone(remoteUri, workingDir);

		logger?.debug(`Checking out ${featBranch}`);
		// The trailing `--` marks the branch as a revision rather than a path,
		// as otherwise the checkout is ambiguous and fails when a top-level
		// file or directory has the same name as the branch, e.g. `docs`
		await git.checkout([featBranch, '--']);

		// Only rebase the commits that were expected, i.e. the ones whose
		// verification was checked to decide whether to sign the rebased commits
		const headSha = await git.revparse('HEAD');
		if (headSha !== featHeadSha) {
			throw new RemoteChangedError(
				`Expected ${featBranch} to be at ${featHeadSha} but it is at ${headSha}`,
			);
		}

		logger?.debug(`Rebasing ${featBranch} onto ${baseBranch}`);
		const wasRebased = await doRebase(git, baseBranch);

		// Only modify remote if rebase was performed
		if (wasRebased) {
			logger?.debug(`Pushing ${featBranch} to origin`);
			await forcePushWithLease(git, featBranch, featHeadSha);
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
export async function doRebase(
	git: SimpleGit,
	baseBranch: string,
): Promise<boolean> {
	// Rebase onto the remote base branch, as a fresh clone only has a local
	// branch for the repo's default branch
	try {
		const rebaseArgs = [`origin/${baseBranch}`];

		const message = await git.rebase(rebaseArgs);
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

async function forcePushWithLease(
	git: SimpleGit,
	branch: string,
	expectedSha: string,
) {
	try {
		await git.push('origin', branch, [
			`--force-with-lease=${branch}:${expectedSha}`,
		]);
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			// Local git detected the ref change
			(error.message.includes('[rejected] (stale info)') ||
				// Remote rejected the push due to ref change
				new RegExp(`is at [a-f0-9]{40} but expected [a-f0-9]{40}`).test(
					error.message,
				) ||
				// Remote rejected the push due to ref change, as reported by newer
				// git versions which update refs in batches
				error.message.includes('(incorrect old value provided)'))
		) {
			throw new RemoteChangedError(error.message);
		}
		throw error; // Re-throw the error otherwise
	}
}

import type { Context } from 'probot';
import type { Endpoints } from '@octokit/types';

import { isHttpError, CodeConflictError } from './errors.js';

/**
 * Create a reaction to an issue comment
 *
 * Pull requests are just issues with code, so the same endpoint is used for both.
 * A status code 200 indicates the reaction already exists, so warn and proceed.
 *
 * See: https://docs.github.com/en/rest/reactions/reactions#create-reaction-for-an-issue-comment
 */
export const createIssueCommentReaction = async (
	ctx: Context,
	commentId: number,
	content: Endpoints['POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions']['parameters']['content'],
) => {
	const { status, data } = await ctx.octokit.reactions.createForIssueComment({
		...ctx.repo(),
		comment_id: commentId,
		content,
	});

	if (status === 200) {
		ctx.log.warn(`Already reacted with ${content} emoji to issue comment`);
	}

	return data;
};

/**
 * Create a commit
 *
 * See: https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28#create-a-commit
 */
const createCommit = async (
	ctx: Context,
	opts: Partial<{
		author: { name: string; email: string };
		committer: { name: string; email: string };
		message: string;
		parents: string[];
		tree: string;
	}>,
) => {
	const { data } = await ctx.octokit.git.createCommit({
		...ctx.repo(),
		...opts,
	});

	return data;
};

/**
 * Merge a commit into a branch using branch base ref and commit SHA,
 * then return the tree SHA
 *
 * See: https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#merge-a-branch
 */
const merge = async (
	ctx: Context,
	{
		base,
		commit,
	}: {
		base: string;
		commit: string;
	},
) => {
	try {
		const {
			data: {
				commit: {
					tree: { sha: tree },
				},
			},
		} = await ctx.octokit.repos.merge({
			...ctx.repo(),
			base,
			head: commit,
			commit_message: `Merge ${commit} into ${base}`,
		});

		return tree;
	} catch (error) {
		if (!isHttpError(error)) {
			throw error;
		}

		if (error.status === 409) {
			throw new CodeConflictError(
				`Merge conflict while merging ${commit} into ${base}`,
				commit,
			);
		}

		throw new Error(
			`Failed to merge ${commit} into ${base} with status ${error.status}`,
		);
	}
};

/**
 * Cherry-pick a commit onto a branch
 *
 * See: https://stackoverflow.com/questions/53859199/how-to-cherry-pick-through-githubs-api
 */
const cherryPickCommit = async (
	ctx: Context,
	{
		commitSha,
		branch,
	}: {
		commitSha: string;
		branch: { ref: string; sha: string; tree: string };
	},
) => {
	// Get to-be-rebased commit details
	const {
		data: { parents, author, committer, message },
	} = await ctx.octokit.git.getCommit({
		...ctx.repo(),
		commit_sha: commitSha,
	});

	if (parents.length > 1) {
		throw new Error(
			`Commit ${commitSha} is a merge commit and cannot be cherry-picked`,
		);
	}

	// Create "tip of tree" sibling commit to trick git into merging a tree of size 1
	const siblingCommit = await createCommit(ctx, {
		author,
		message: `Temp sibling of ${commitSha}`,
		parents: [parents[0].sha],
		tree: branch.tree,
	});

	// Update ref to sibling commit
	await ctx.octokit.git.updateRef({
		...ctx.repo(),
		ref: `heads/${branch.ref}`,
		sha: siblingCommit.sha,
		force: true,
	});

	// Merge to-be-rebased commit onto branch
	const tree = await merge(ctx, {
		base: branch.ref,
		commit: commitSha,
	});

	// Cherry-pick commit with original message
	const newHead = await createCommit(ctx, {
		author,
		committer,
		message,
		parents: [branch.sha],
		tree,
	});

	// Update ref to final commit
	await ctx.octokit.git.updateRef({
		...ctx.repo(),
		ref: `heads/${branch.ref}`,
		sha: newHead.sha,
		force: true,
	});

	return { sha: newHead.sha, tree: newHead.tree };
};

export const rebase = async (
	ctx: Context,
	pr: Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data'],
) => {
	const tempBranchName = `basejump/rebase-pr-${pr.number}-${Date.now()}`;
	try {
		// Fetch base SHA in case pr.base.sha is outdated
		const { data: baseCommit } = await ctx.octokit.repos.getCommit({
			...ctx.repo(),
			ref: pr.base.ref,
		});

		// Get all commits from PR
		const { data: commits } = await ctx.octokit.pulls.listCommits({
			...ctx.repo(),
			pull_number: pr.number,
		});

		// Create temp branch from base commit
		await ctx.octokit.git.createRef({
			...ctx.repo(),
			ref: `refs/heads/${tempBranchName}`,
			sha: baseCommit.sha,
		});

		// Cherry-pick each commit
		let currentSha = pr.base.sha;
		let currentTree = baseCommit.commit.tree.sha;

		for (const commit of commits) {
			const result = await cherryPickCommit(ctx, {
				commitSha: commit.sha,
				branch: {
					ref: tempBranchName,
					sha: currentSha,
					tree: currentTree,
				},
			});
			currentSha = result.sha;
			currentTree = result.tree.sha;
		}

		// Update PR branch with rebased commits
		await ctx.octokit.git.updateRef({
			...ctx.repo(),
			ref: `heads/${pr.head.ref}`,
			sha: currentSha,
			force: true,
		});
	} finally {
		// Regardless of success or failure, clean up temp branch
		await ctx.octokit.git.deleteRef({
			...ctx.repo(),
			ref: `heads/${tempBranchName}`,
		});
	}
};

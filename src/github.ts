import type { Context, Logger } from 'probot';
import type { Endpoints } from '@octokit/types';

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
	logger: Logger,
) => {
	const { status, data } = await ctx.octokit.reactions.createForIssueComment({
		...ctx.repo(),
		comment_id: commentId,
		content,
	});

	if (status === 200) {
		logger.warn(`Already reacted with ${content} emoji to issue comment`);
	}

	return data;
};

export const areCommitsVerified = async (
	ctx: Context<'issue_comment.created'>,
	logger: Logger,
): Promise<boolean> => {
	try {
		// Get all commits for the PR
		const { data: commits } = await ctx.octokit.rest.pulls.listCommits({
			...ctx.repo(),
			pull_number: ctx.payload.issue.number,
		});

		// Split commits into verified and unverified
		const verifiedCommits = [];
		const unverifiedCommits = [];
		for (const { sha, commit } of commits) {
			// Log each commit's current author and committer
			logger.info(
				`Processing commit: ${JSON.stringify({
					sha,
					author: commit.author,
					committer: commit.committer,
				})}`,
			);
			if (
				commit.verification?.verified &&
				commit.verification?.reason === 'valid'
			) {
				verifiedCommits.push({ sha, commit });
			} else {
				logger.warn(
					`Commit ${sha} is unverified with reason "${commit.verification?.reason}"`,
				);
				unverifiedCommits.push({ sha, commit });
			}
		}

		// Only return true if there are no unverified commits
		return unverifiedCommits.length === 0;
	} catch (error) {
		logger.error(
			`Error checking commits: ${error instanceof Error ? error.message : error}. Proceeding as if commits are unverified`,
		);
		// If any API error, proceed as if commits are unverified
		return false;
	}
};

/**
 * Get the installation token for the GitHub app
 * @param ctx - The context object
 * @returns The installation token
 */
export const getInstallationToken = async (
	ctx: Context<'issue_comment.created'>,
): Promise<string | null> => {
	const installationToken = await ctx.octokit.auth({
		type: 'installation',
		installationId: ctx.payload.installation?.id,
	});

	// The returned installation token is of type `unknown`
	if (
		typeof installationToken === 'object' &&
		installationToken !== null &&
		'token' in installationToken &&
		typeof installationToken.token === 'string'
	) {
		return installationToken.token;
	}
	return null;
};

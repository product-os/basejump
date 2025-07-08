import type { Context } from 'probot';
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

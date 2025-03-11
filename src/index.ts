import type { Probot } from 'probot';

import { createIssueCommentReaction, rebase } from './github.js';
import { isCodeConflictError, isHttpError } from './errors.js';

export default (app: Probot) => {
	// Pull request comments are just issue comments with code
	// See: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
	app.on('issue_comment.created', async (ctx) => {
		const startTime = Date.now();
		const { issue, comment } = ctx.payload;

		// Don't rebase if:
		// - Comment doesn't start with "/rebase", or
		// - Issue is not a PR
		if (!comment.body.startsWith('/rebase') || !issue.pull_request) {
			return;
		}

		const { owner, repo } = ctx.repo();

		const withPrefix = (message: string) =>
			`[basejump/${owner}/${repo}/pr-${issue.number}] ${message}`;

		ctx.log.info(withPrefix('Received rebase request'));

		let eyesReactionId: number | undefined;

		try {
			// Indicate request received by reacting with an eyes emoji
			const { id } = await createIssueCommentReaction(ctx, comment.id, 'eyes');
			eyesReactionId = id;

			// No need to rebase if branch already up to date with base branch
			ctx.log.info(withPrefix('Checking rebase necessity'));

			const { data: pr } = await ctx.octokit.pulls.get({
				...ctx.repo(),
				pull_number: issue.number,
			});

			const {
				data: { behind_by },
			} = await ctx.octokit.rest.repos.compareCommitsWithBasehead({
				...ctx.repo(),
				basehead: `${pr.base.ref}...${pr.head.ref}`,
			});

			// Branch isn't behind base, so no rebase needed
			if (behind_by === 0) {
				ctx.log.warn(
					withPrefix('PR is already up to date with base branch, exiting'),
				);
				await createIssueCommentReaction(ctx, comment.id, 'confused');
				return;
			}

			ctx.log.info(withPrefix('Proceeding with rebase'));

			// Rebase using cherry-picks, as there is no API for rebasing a PR
			await rebase(ctx, pr);

			// Notify success with rocket emoji
			await createIssueCommentReaction(ctx, comment.id, 'rocket');
		} catch (error) {
			if (isCodeConflictError(error)) {
				// Only notify user of rebase failure on code conflict,
				// not internal error
				const messageParts = [
					`Failed to rebase: Conflict detected when applying commit ${error.commitSha.substring(0, 7)}.`,
					'Please resolve the conflict and push again.',
				];
				await ctx.octokit.issues.createComment({
					...ctx.repo(),
					issue_number: issue.number,
					body: messageParts.join('\n\n'),
				});

				ctx.log.error(withPrefix(messageParts.join(' ')));
			} else if (isHttpError(error)) {
				const {
					status,
					response: { data },
				} = error;
				ctx.log.error(
					withPrefix(`Failed to rebase with status ${status}: ${data}`),
				);
			} else {
				ctx.log.error(withPrefix(`Failed to rebase: ${error}`));
			}

			// Notify error with confused emoji
			await createIssueCommentReaction(ctx, comment.id, 'confused');
		} finally {
			// Remove stale reaction regardless of success or failure
			if (eyesReactionId) {
				await ctx.octokit.reactions.deleteForIssueComment({
					...ctx.repo(),
					comment_id: comment.id,
					reaction_id: eyesReactionId,
				});
			}

			const duration = Date.now() - startTime;
			ctx.log.info(withPrefix(`Completed in ${duration}ms`));
		}
	});
};

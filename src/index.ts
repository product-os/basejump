import type { Probot, Context, Logger } from 'probot';

import {
	createIssueCommentReaction,
	areCommitsVerified,
	getInstallationToken,
} from './github.js';
import {
	isCodeConflictError,
	isHttpError,
	RemoteChangedError,
} from './errors.js';
import rebase from './rebase.js';

// Attach a prefix to all log messages
const loggerWithPrefix = (
	ctx: Context,
	prefixer: (prefix: string) => string,
) => {
	return {
		info: (message: string) => {
			ctx.log.info(prefixer(message));
		},
		warn: (message: string) => {
			ctx.log.warn(prefixer(message));
		},
		error: (message: string) => {
			ctx.log.error(prefixer(message));
		},
		debug: (message: string) => {
			ctx.log.debug(prefixer(message));
		},
	} as Logger;
};

export default (app: Probot) => {
	// Pull request comments are just issue comments with code
	// See: https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
	app.on(
		'issue_comment.created',
		async (ctx: Context<'issue_comment.created'>) => {
			const startTime = Date.now();
			const { issue, comment } = ctx.payload;

			// Don't rebase if:
			// - Comment doesn't start with "/rebase", or
			// - Issue is not a PR
			if (!comment.body.startsWith('/rebase') || !issue.pull_request) {
				return;
			}

			const { owner, repo } = ctx.repo();

			const logger = loggerWithPrefix(
				ctx,
				(message) =>
					`[basejump/${owner}/${repo}/pr-${issue.number}] ${message}`,
			);

			logger.info('Received rebase request');

			let eyesReactionId: number | undefined;

			try {
				// Indicate request received by reacting with an eyes emoji
				const { id } = await createIssueCommentReaction(
					ctx,
					comment.id,
					'eyes',
					logger,
				);
				eyesReactionId = id;

				// No need to rebase if branch already up to date with base branch
				logger.info('Checking rebase necessity');

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
					logger.warn('PR is already up to date with base branch, exiting');
					await createIssueCommentReaction(ctx, comment.id, 'confused', logger);
					return;
				}

				logger.info('Proceeding with rebase');

				// Get the installation token
				const authToken = await getInstallationToken(ctx);
				if (!authToken) {
					logger.error('Failed to retrieve auth token, aborting rebase');
					await createIssueCommentReaction(ctx, comment.id, 'confused', logger);
					return;
				}

				// For each commit, get verification status
				const shouldSignDuringRebase = await areCommitsVerified(ctx, logger);

				if (!shouldSignDuringRebase) {
					logger.warn(
						'Not all commits are verified. Proceeding with rebase without signing commits',
					);
				} else {
					logger.info(
						'All commits are verified. Proceeding with rebase with signed commits',
					);
				}

				// Set up options for local rebase
				// Use authenticated URI for HTTPS-based git clone
				const remoteUri = ctx.payload.repository.clone_url.replace(
					'https://',
					`https://x-access-token:${authToken}@`,
				);
				const featBranch = pr.head.ref;
				const baseBranch = pr.base.ref;
				const gitConfig = [
					`user.name=${process.env.GIT_COMMITTER_NAME}`,
					`user.email=${process.env.GIT_COMMITTER_EMAIL}`,
					`committer.name=${process.env.GIT_COMMITTER_NAME}`,
					`committer.email=${process.env.GIT_COMMITTER_EMAIL}`,
				];

				// If all commits are verified, sign them during rebase
				if (shouldSignDuringRebase && process.env.KEY_ID) {
					gitConfig.push('commit.gpgsign=true');
					gitConfig.push(`user.signingkey=${process.env.KEY_ID}`);
				} else {
					gitConfig.push('commit.gpgsign=false');
				}

				// Rebase locally with git
				await rebase(remoteUri, featBranch, baseBranch, gitConfig, logger);

				// Notify success with rocket emoji
				await createIssueCommentReaction(ctx, comment.id, 'rocket', logger);
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

					logger.error(messageParts.join(' '));
				} else if (error instanceof RemoteChangedError) {
					logger.error(
						'Failed to rebase: branch changes detected since rebase was triggered',
					);
				} else if (isHttpError(error)) {
					const {
						response: { data },
					} = error;
					logger.error(`Failed to rebase: ${JSON.stringify(data)}`);
				} else {
					logger.error(`Failed to rebase: ${error}`);
				}

				// Notify error with confused emoji
				await createIssueCommentReaction(ctx, comment.id, 'confused', logger);
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
				logger.info(`Completed in ${duration}ms`);
			}
		},
	);
};

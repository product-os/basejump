import nock from 'nock';
import { Probot, ProbotOctokit } from 'probot';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	describe,
	beforeEach,
	afterEach,
	beforeAll,
	test,
	expect,
} from 'vitest';

import app from '../src/index.js';
import payload from './fixtures/issue_comment.created.pull_request.json' with { type: 'json' };

describe('basejump', () => {
	const dirname = path.dirname(fileURLToPath(import.meta.url));
	let probot: any;
	let privateKey: string;

	const TMP_BRANCH_PREFIX = 'basejump/rebase-pr-';
	const INSTALLATION_ID = payload.installation.id;
	const COMMENT_ID = payload.comment.id;
	const PR_NUMBER = payload.issue.number;
	const EYES_REACTION_ID = 123;

	beforeAll(async () => {
		privateKey = await fs.readFile(
			path.join(dirname, 'fixtures/mock-cert.pem'),
			'utf-8',
		);
	});

	beforeEach(() => {
		nock.disableNetConnect();
		probot = new Probot({
			appId: 123,
			privateKey,
			// disable request throttling and retries for testing
			Octokit: ProbotOctokit.defaults({
				retry: { enabled: false },
				throttle: { enabled: false },
			}),
		});
		probot.load(app);
	});

	afterEach(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});

	test('ignores non-rebase comments', async () => {
		await probot.receive({
			name: 'issue_comment',
			payload: {
				...payload,
				comment: {
					...payload.comment,
					body: 'not a /rebase comment',
				},
			},
		});
		// No API calls should be made
		expect(nock.pendingMocks()).toHaveLength(0);
	});

	test('ignores rebase comments on regular issues', async () => {
		await probot.receive({
			name: 'issue_comment',
			payload: {
				...payload,
				issue: {
					...payload.issue,
					pull_request: undefined,
				},
				comment: {
					...payload.comment,
					body: '/rebase',
				},
			},
		});
		expect(nock.pendingMocks()).toHaveLength(0);
	});

	test('handles up-to-date branches', async () => {
		const mock = nock('https://api.github.com')
			// Probot gets an auth token on our behalf
			.post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
			.reply(200, { token: 'test' })
			// Initial eyes reaction on comment
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
				{
					content: 'eyes',
				},
			)
			.reply(201, { id: EYES_REACTION_ID })
			// Get PR details
			.get(`/repos/balena-user/github-app-test/pulls/${PR_NUMBER}`)
			.reply(200, {
				number: PR_NUMBER,
				base: { ref: 'main' },
				head: { ref: 'feature' },
			})
			// Compare branches to check if rebase is needed
			.get(`/repos/balena-user/github-app-test/compare/main...feature`)
			.reply(200, { behind_by: 0 })
			// Confused reaction on comment to indicate a rebase was requested
			// where none was needed
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
				{
					content: 'confused',
				},
			)
			.reply(201)
			// Delete eyes reaction from comment
			.delete(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions/${EYES_REACTION_ID}`,
			)
			.reply(204);

		await probot.receive({
			name: 'issue_comment',
			payload: {
				...payload,
				comment: { ...payload.comment, body: '/rebase please' },
			},
		});

		expect(mock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase with one feature branch commit', async () => {
		const mock = nock('https://api.github.com')
			.post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
			.reply(200, { token: 'test' })
			// Initial eyes reaction
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
			)
			.reply(201, { id: EYES_REACTION_ID })
			// Get PR (feature)
			.get(`/repos/balena-user/github-app-test/pulls/${PR_NUMBER}`)
			.reply(200, {
				number: PR_NUMBER,
				base: { ref: 'main', sha: 'base-sha' },
				head: { ref: 'feature', sha: 'head-sha' },
			})
			// Compare branches, with behind_by indicating a rebase is required
			.get('/repos/balena-user/github-app-test/compare/main...feature')
			.reply(200, {
				status: 'diverged',
				ahead_by: 1,
				behind_by: 2,
				total_commits: 1,
			})
			// Get base commit (D)
			.get('/repos/balena-user/github-app-test/commits/main')
			.reply(200, {
				sha: 'base-sha',
				commit: { tree: { sha: 'base-tree-sha' } },
			})
			// List feature branch commits
			.get(`/repos/balena-user/github-app-test/pulls/${PR_NUMBER}/commits`)
			.reply(200, [{ sha: 'commit-1' }])
			// Create temp branch from base commit
			.post('/repos/balena-user/github-app-test/git/refs', (body) => {
				expect(body.ref.startsWith(`refs/heads/${TMP_BRANCH_PREFIX}`)).toEqual(
					true,
				);
				expect(body.sha).toEqual('base-sha');
				return true;
			})
			.reply(201)
			// Cherry-pick 1: get the feature branch commit (E)
			.get('/repos/balena-user/github-app-test/git/commits/commit-1')
			.reply(200, {
				parents: [{ sha: 'parent' }],
				author: { name: 'test', email: 'test@test.com' },
				committer: { name: 'test', email: 'test@test.com' },
				message: 'test commit',
			})
			// Cherry-pick 2: create a temp sibling commit (F)
			.post('/repos/balena-user/github-app-test/git/commits', (body) => {
				expect(body.message).toEqual('Temp sibling of commit-1');
				expect(body.parents[0]).toEqual('parent');
				expect(body.tree).toEqual('base-tree-sha');
				return true;
			})
			.reply(201, { sha: 'sibling-sha' })
			// Cherry-pick 3: update ref to sibling commit
			.patch(
				(uri) => {
					return uri.startsWith(
						'/repos/balena-user/github-app-test/git/refs/heads%2Fbasejump%2Frebase-pr-',
					);
				},
				(body) => {
					expect(body.sha).toEqual('sibling-sha');
					expect(body.force).toEqual(true);
					return true;
				},
			)
			.reply(201)
			// Cherry-pick 4: merge original commit onto branch
			.post('/repos/balena-user/github-app-test/merges', (body) => {
				expect(body.base.startsWith(TMP_BRANCH_PREFIX)).toEqual(true);
				expect(body.head).toEqual('commit-1');
				expect(
					body.commit_message.startsWith(
						`Merge commit-1 into ${TMP_BRANCH_PREFIX}`,
					),
				).toEqual(true);
				return true;
			})
			.reply(201, {
				commit: {
					tree: { sha: 'tmp-tree-sha' },
				},
			})
			// Cherry-pick 5: create a new commit with original message
			.post('/repos/balena-user/github-app-test/git/commits', (body) => {
				expect(body.message).toEqual('test commit');
				expect(body.parents[0]).toEqual('base-sha');
				expect(body.tree).toEqual('tmp-tree-sha');
				return true;
			})
			.reply(201, {
				sha: 'rebased-commit-sha',
				tree: { sha: 'rebased-tree-sha' },
			})
			// Cherry-pick 6: update ref to new commit
			.patch(
				(uri) =>
					uri.startsWith(
						'/repos/balena-user/github-app-test/git/refs/heads%2Fbasejump%2Frebase-pr-',
					),
				(body) => {
					expect(body.sha).toEqual('rebased-commit-sha');
					expect(body.force).toEqual(true);
					return true;
				},
			)
			.reply(201)
			// After cherry-picks: Update PR branch with rebased commit
			.patch(
				(uri) =>
					uri.startsWith(
						'/repos/balena-user/github-app-test/git/refs/heads%2Ffeature',
					),
				(body) => {
					expect(body.sha).toEqual('rebased-commit-sha');
					expect(body.force).toEqual(true);
					return true;
				},
			)
			.reply(201)
			// Clean up temp branch
			.delete((uri) =>
				uri.startsWith(
					'/repos/balena-user/github-app-test/git/refs/heads%2Fbasejump%2Frebase-pr-',
				),
			)
			.reply(204)
			// React to rebase success
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
				{
					content: 'rocket',
				},
			)
			.reply(201)
			// Delete eyes reaction
			.delete(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions/${EYES_REACTION_ID}`,
			)
			.reply(204);

		await probot.receive({
			name: 'issue_comment',
			payload,
		});

		expect(mock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase with a code conflict', async () => {
		const mock = nock('https://api.github.com')
			.post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
			.reply(200, { token: 'test' })
			// Initial eyes reaction
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
			)
			.reply(201, { id: EYES_REACTION_ID })
			// Get PR (feature)
			.get(`/repos/balena-user/github-app-test/pulls/${PR_NUMBER}`)
			.reply(200, {
				number: PR_NUMBER,
				base: { ref: 'main', sha: 'base-sha' },
				head: { ref: 'feature', sha: 'head-sha' },
			})
			// Compare branches, with behind_by indicating a rebase is required
			.get('/repos/balena-user/github-app-test/compare/main...feature')
			.reply(200, {
				status: 'diverged',
				ahead_by: 1,
				behind_by: 2,
				total_commits: 1,
			})
			// Get base commit (D)
			.get('/repos/balena-user/github-app-test/commits/main')
			.reply(200, {
				sha: 'base-sha',
				commit: { tree: { sha: 'base-tree-sha' } },
			})
			// List feature branch commits
			.get(`/repos/balena-user/github-app-test/pulls/${PR_NUMBER}/commits`)
			.reply(200, [{ sha: 'commit-1' }])
			// Create temp branch from base commit
			.post('/repos/balena-user/github-app-test/git/refs', (body) => {
				expect(body.ref.startsWith(`refs/heads/${TMP_BRANCH_PREFIX}`)).toEqual(
					true,
				);
				expect(body.sha).toEqual('base-sha');
				return true;
			})
			.reply(201)
			// Cherry-pick 1: get the feature branch commit (E)
			.get('/repos/balena-user/github-app-test/git/commits/commit-1')
			.reply(200, {
				parents: [{ sha: 'parent' }],
				author: { name: 'test', email: 'test@test.com' },
				committer: { name: 'test', email: 'test@test.com' },
				message: 'test commit',
			})
			// Cherry-pick 2: create a temp sibling commit (F)
			.post('/repos/balena-user/github-app-test/git/commits', (body) => {
				expect(body.message).toEqual('Temp sibling of commit-1');
				expect(body.parents[0]).toEqual('parent');
				expect(body.tree).toEqual('base-tree-sha');
				return true;
			})
			.reply(201, { sha: 'sibling-sha' })
			// Cherry-pick 3: update ref to sibling commit
			.patch(
				(uri) => {
					return uri.startsWith(
						'/repos/balena-user/github-app-test/git/refs/heads%2Fbasejump%2Frebase-pr-',
					);
				},
				(body) => {
					expect(body.sha).toEqual('sibling-sha');
					expect(body.force).toEqual(true);
					return true;
				},
			)
			.reply(201)
			// Cherry-pick 4: merge original commit onto branch, and raise code conflict
			.post('/repos/balena-user/github-app-test/merges', (body) => {
				expect(body.base.startsWith(TMP_BRANCH_PREFIX)).toEqual(true);
				expect(body.head).toEqual('commit-1');
				expect(
					body.commit_message.startsWith(
						`Merge commit-1 into ${TMP_BRANCH_PREFIX}`,
					),
				).toEqual(true);
				return true;
			})
			.reply(409, {
				status: 409,
				response: { data: { message: 'Merge conflict' } },
			})
			// Clean up temp branch
			.delete((uri) =>
				uri.startsWith(
					'/repos/balena-user/github-app-test/git/refs/heads%2Fbasejump%2Frebase-pr-',
				),
			)
			.reply(204)
			// Create a comment on the PR with the code conflict error
			.post(
				`/repos/balena-user/github-app-test/issues/${PR_NUMBER}/comments`,
				(body) => {
					expect(body.body).toEqual(
						`Failed to rebase: Conflict detected when applying commit ${'commit-1'.substring(0, 7)}.\n` +
							'\n' +
							'Please resolve the conflict and push again.',
					);
					return true;
				},
			)
			.reply(201)
			// React to rebase failure
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
				{
					content: 'confused',
				},
			)
			.reply(201)
			// Delete eyes reaction
			.delete(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions/${EYES_REACTION_ID}`,
			)
			.reply(204);

		await probot.receive({
			name: 'issue_comment',
			payload,
		});

		expect(mock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase with other HTTP errors from GH API', async () => {
		const mock = nock('https://api.github.com')
			.post(`/app/installations/${INSTALLATION_ID}/access_tokens`)
			.reply(200, { token: 'test' })
			// Initial eyes reaction
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
			)
			.reply(201, { id: EYES_REACTION_ID })
			// Get PR and fail
			.get(`/repos/balena-user/github-app-test/pulls/${PR_NUMBER}`)
			.reply(404, {
				status: 404,
				response: { data: { message: 'Not Found' } },
			})
			// React to rebase failure
			.post(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions`,
				{
					content: 'confused',
				},
			)
			.reply(201)
			// Delete eyes reaction
			.delete(
				`/repos/balena-user/github-app-test/issues/comments/${COMMENT_ID}/reactions/${EYES_REACTION_ID}`,
			)
			.reply(204);

		await probot.receive({
			name: 'issue_comment',
			payload,
		});

		expect(mock.pendingMocks()).toHaveLength(0);
	});
});

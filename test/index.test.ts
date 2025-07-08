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
	vi,
} from 'vitest';

import app from '../src/index.js';
import rebase from '../src/rebase.js';
import { CodeConflictError, RemoteChangedError } from '../src/errors.js';
import payload from './fixtures/issue_comment.created.pull_request.json' with { type: 'json' };

// Mock the rebase module, as it's unit tested elsewhere
// and its network calls are not easy to mock in this test file
vi.mock('../src/rebase.js', () => ({
	default: vi.fn(),
}));

const rebaseMock = vi.mocked(rebase);

describe('basejump', () => {
	const dirname = path.dirname(fileURLToPath(import.meta.url));
	let probot: any;
	let privateKey: string;

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
		vi.clearAllMocks();
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
		const githubMock = nock('https://api.github.com')
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

		expect(githubMock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase', async () => {
		// Mock rebase success
		rebaseMock.mockResolvedValue(undefined);

		const githubMock = nock('https://api.github.com')
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
			// This is where the rebase takes place, but it's mocked here so there are no network calls
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

		expect(rebaseMock).toHaveBeenCalledOnce();
		expect(githubMock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase where PR base sha is outdated', async () => {
		const githubMock = nock('https://api.github.com')
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
			// This is where the rebase takes place, but it's mocked here so there are no network calls
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

		expect(rebaseMock).toHaveBeenCalledOnce();
		expect(githubMock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase where feature branch head sha has changed', async () => {
		// Remote feature branch head sha has changed, so rebase should throw RemoteChangedError
		rebaseMock.mockRejectedValue(new RemoteChangedError('Remote changed'));

		const githubMock = nock('https://api.github.com')
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
			// This is where the rebase takes place, but it's mocked here so there are no network calls
			// Notify of rebase failure
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

		expect(rebaseMock).toHaveBeenCalledOnce();
		expect(githubMock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase with a code conflict', async () => {
		// Mock rebase failure with a code conflict
		rebaseMock.mockRejectedValue(
			new CodeConflictError('Conflict detected', 'commit-1'),
		);

		const githubMock = nock('https://api.github.com')
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
			// This is where the rebase takes place, but it's mocked here so there are no network calls
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

		expect(rebaseMock).toHaveBeenCalledOnce();
		expect(githubMock.pendingMocks()).toHaveLength(0);
	});

	test('handles rebase with other HTTP errors from GH API', async () => {
		const githubMock = nock('https://api.github.com')
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

		expect(rebaseMock).not.toHaveBeenCalled();
		expect(githubMock.pendingMocks()).toHaveLength(0);
	});
});

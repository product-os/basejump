import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		coverage: {
			provider: 'v8',
		},
		testTimeout: 30000,
		watch: false,
		env: {
			GIT_COMMITTER_NAME: 'Basejump Test Bot',
			GIT_COMMITTER_EMAIL: 'basejump-test@balena.io',
			KEY_ID: 'deadbeef',
		},
	},
});

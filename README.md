# Basejump

Basejump is a GitHub App that automates the rebasing of pull requests on-demand using local git operations.

## Overview

Basejump monitors pull request comments on your repositories. When a comment starting with `/rebase` is posted on a pull request, Basejump clones the repository locally and performs a native git rebase operation.

## How It Works

### Triggering a Rebase

To trigger a rebase, simply comment on a pull request with:

```
/rebase
```

### Process Flow

1. **Comment Detection**: Basejump listens for new issue comments and begins the rebase process when a comment starts with `/rebase` on a pull request.

2. **Initial Feedback**: An eyes reaction (👀) is added to the comment to indicate the request was received and is removed once the process completes.

3. **Rebase Necessity Check**: Basejump checks if rebasing is necessary by comparing the PR branch with its base branch. If the PR branch is already up-to-date, it adds a confused reaction (😕) and exits.

4. **Commit Verification**: Basejump queries the verification statuses of the commits in the pull request. If all the commits are verified by GitHub (i.e. authored/committed & signed by a key that matches an identity known to GitHub), Basejump will sign the rebased commits using its service account key. However, if ANY commit cannot be verified by GitHub, Basejump will not sign any commits during rebase.

5. **Local Git Rebase**: If rebasing is needed, Basejump:
   - Clones the repository to a temporary directory
   - Checks out the feature branch
   - Performs a native `git rebase` operation
   - Force-pushes the rebased branch using `--force-with-lease` for safety
   - Cleans up the temporary directory

6. **Result Notification**: Upon completion, Basejump adds:
   - A rocket reaction (🚀) for successful rebases
   - A confused reaction (😕) for failures
   - An explanatory comment for code conflicts that require manual resolution

## Implementation Details

- **Framework**: Built as a GitHub App using the [Probot](https://probot.github.io/) framework
- **Language**: TypeScript with ES modules
- **Git Operations**: Uses [simple-git](https://github.com/steveukx/git-js) library for native git operations
- **Safety**: Uses `--force-with-lease` to prevent overwriting concurrent changes

### Key Features

- **Native Git Behavior**: Follows standard git rebase behavior including:
  - Dropping merge commits
  - Skipping commits already cherry-picked to the base branch
  - Preserving intentionally empty commits (`--allow-empty`)
- **Conflict Detection**: Gracefully aborts and reports merge conflicts with commit SHA references
- **Concurrent Change Protection**: Gracefully aborts if remote branch is updated during rebase

## Setup

### Development

```sh
# Install dependencies
npm ci

# Build the project
npm run build

# Run tests
npm test

# Start the bot after setting WEBHOOK_PROXY_URL in .env
npm start
```

### Environment Variables

The following environment variables are required:

- `APP_ID`: Your GitHub App ID
- `PRIVATE_KEY`: Your GitHub App private key (PEM format)
- `WEBHOOK_SECRET`: Your GitHub App webhook secret (optional)

### Docker

```sh
# 1. Build container
docker build -t basejump .

# 2. Run container with environment variables
docker run \
  -e APP_ID=<app-id> \
  -e PRIVATE_KEY=<pem-value> \
  basejump
```

### GPG Commit Signing

Basejump signs commit if all the commits in the pull request are verified by GitHub. Additional setup is required:

```sh
# Run with GPG signing enabled
docker run \
  -e APP_ID=<app-id> \
  -e PRIVATE_KEY=<pem-value> \
  -e GPG_KEY_FILE=/usr/src/app/gpg-key.asc \
  -v ./your-gpg-key.asc:/usr/src/app/gpg-key.asc:ro \
  basejump
```

**GPG Setup Process (`setup.sh`):**
The container automatically runs `setup.sh` on startup which:
1. Creates GPG configuration files (`~/.gnupg/gpg.conf`)
2. Imports the passwordless GPG private key from a volume with, with path set to env var `$GPG_KEY_FILE`
3. Sets ultimate trust on the imported key
4. Exports the `KEY_ID` environment variable for use by the app

**Required GPG Environment Variables:**
- `GPG_KEY_FILE`: Container path to the passwordless GPG private key file (must be mounted into container)
- `GIT_COMMITTER_NAME`: Name for git commits
- `GIT_COMMITTER_EMAIL`: Email for git commits

## Development

### Testing

```sh
# Run tests
npm test

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix
```
## Contributing

If you have suggestions for how basejump could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © 2025 Balena

# Basejump

Basejump is a GitHub App that automates the rebasing of pull requests on-demand.

## Overview

Basejump monitors pull request comments on your repositories. When a comment starting with `/rebase` is posted on a pull request, Basejump attempts to rebase the PR branch onto its base branch.

## How It Works

### Triggering a Rebase

To trigger a rebase, simply comment on a pull request with:

```
/rebase
```

### Process Flow

1. Basejump listens for new issue comments and begins the rebase process when a comment starts with `/rebase` on a pull request.

2. An eyes reaction (👀) is added to the comment to indicate the request was received and is removed once the process completes.

3. Basejump checks if rebasing is necessary; if the PR branch is already up-to-date with its base branch, it adds a confused reaction (😕) and exits.

4. If rebasing is needed, Basejump performs the operation using a cherry-pick approach since GitHub's API doesn't offer a direct rebase function.

5. Upon completion, Basejump adds a rocket reaction (🚀) for success or a confused reaction (😕) for failure, with an explanatory comment for code conflicts that require manual resolution.

## Implementation Details

- Basejump operates as a GitHub App using the [Probot](https://probot.github.io/) framework
- It uses the GitHub REST API to manage repositories, pull requests, and reactions
- Since GitHub doesn't provide a direct rebase API, Basejump implements its own rebasing mechanism using cherry-pick

## Limitations

- Cannot rebase pull requests that would result in merge conflicts (requires manual intervention)
- Does not sign rebased commits, due to limitations of GitHub's REST API

## Setup

```sh
# Install dependencies
npm ci

# Run the bot
npm start
```

## Docker

```sh
# 1. Build container
docker build -t basejump .

# 2. Populate .env as needed

# 3. Start container
docker run -e APP_ID=<app-id> -e PRIVATE_KEY=<pem-value> basejump
```

## Contributing

If you have suggestions for how basejump could be improved, or want to report a bug, open an issue! We'd love all and any contributions.

For more, check out the [Contributing Guide](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © 2025 Balena

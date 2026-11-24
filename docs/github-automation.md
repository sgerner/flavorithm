# GitHub automation

CI checks Svelte/TypeScript types (including the service worker, `server.mjs`,
and `scripts/*.mjs`), unit tests, the production build, the container build, and
both HTTP and SSO smoke tests against the hardened `flavorithm:ci` container on
pushes and pull requests. Runs use Ubuntu 24.04 and Node 24, have a 20-minute
timeout, and cancel superseded pull-request runs while letting `main`, manual,
and scheduled runs finish.

Dependabot checks npm packages, GitHub Actions, the Dockerfile, and
`deploy/skynet/compose.override.yml` weekly. Minor and patch npm updates are
grouped; major npm updates remain separate for review. GitHub Actions updates
are grouped. Dependency updates run the same CI as other pull requests.
GitHub's Dependabot alerts and automated security-fix pull requests should also
be enabled in repository settings. GitGuardian already checks this repository
for secrets.

The Security workflow runs CodeQL for JavaScript/TypeScript and Actions, plus
a production dependency audit, on pull requests, main pushes, and weekly.
CodeQL results appear under GitHub's Security tab. The audit fails for high
or critical production dependency vulnerabilities.

After both the CI and Security push runs on main succeed for a commit, Publish
container checks that the commit tag is not already in GitHub Container
Registry, checks out that exact verified commit, and publishes:

```text
ghcr.io/sgerner/flavorithm:sha-<full-commit-sha>
```

A read-only gate job checks workflow status and existing registry manifests
first; only the publish job receives package write permission. Pull-request,
scheduled, and manual runs cannot trigger publication. Per-commit concurrency
and commit tags avoid duplicate pushes or a delayed run overwriting a newer
release tag. The workflow uses the built-in GITHUB_TOKEN, so no registry
password needs to be configured. Package visibility and access are controlled
separately in GitHub Packages; publishing does not make a package public.

The Skynet deployment continues to use its existing source updater and health
check rollback described in [Docker deployment](docker-deployment.md).
Publishing a registry image does not deploy it to Skynet. Sidecar image updates
in `deploy/skynet/compose.override.yml` require manual pulls on Skynet because
`deploy/skynet/update.sh` restarts only `flavorithm`.

Workflow and Dependabot files take effect after they are reviewed and merged
to the default branch. These workflows do not merge dependency PRs or perform
unattended host configuration changes.

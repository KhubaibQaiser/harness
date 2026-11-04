# Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`: it checks the tag equals the `package.json` version, runs CI, checks the commit is on main, then publishes to npm with provenance. The publish job runs in the GitHub environment `npm-release`, so it waits for a required reviewer.

## One-time setup (owner)

1. In the GitHub repo, open Settings, then Environments, then New environment. Name it `npm-release`.
2. Under Required reviewers, add yourself and save.
3. On npmjs.com, open the package's trusted-publisher settings and set the environment to `npm-release` (the repository and workflow `release.yml` stay as they are).

## Each release

1. Merge the version bump to main.
2. Tag that commit `vX.Y.Z` (a version with `-` publishes under the `beta` tag, otherwise `latest`) and push the tag.
3. When the run reaches `publish`, approve it in the Actions tab.

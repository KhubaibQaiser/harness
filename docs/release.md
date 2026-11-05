# Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`:
1. It checks that the tag equals the `package.json` version, that the tagged commit is on main, and that `docs/release-notes/<version>.md` exists.
2. It runs CI.
3. It publishes to npm with provenance. This job runs in the GitHub environment `npm-release`, so it waits for a required reviewer.
4. After npm succeeds, two jobs run, both using GitHub's built-in token and no secrets:
   - one publishes the same version to GitHub Packages, so it shows under Packages on the repo page;
   - one creates a GitHub release from the release notes, marked as a pre-release for versions with `-`.

## One-time setup (owner)

1. In the GitHub repo, open Settings, then Environments, then New environment. Name it `npm-release`.
2. Under Required reviewers, add yourself. Leave "Prevent self-review" off: you push the tag and are the only reviewer, so turning it on would lock you out.
3. Optional: under Deployment branches and tags, add a tag rule `v*`, so only release tags can deploy to this environment. (Environments need a public repo or a paid plan.)
4. On npmjs.com, open the package's Settings, then Trusted publisher. npm can't edit an existing connection: delete the old one and create a new one for GitHub Actions with this repository, the workflow `release.yml`, and the environment `npm-release`. The name must match exactly; npm doesn't check it when you save.
5. Under allowed actions, tick `npm publish`. The release job runs that command.
6. A new trusted-publisher config expires if no publish succeeds within 2 days. Push the first release tag, and approve it, within that time, or create the config again.

## Each release

1. Merge the version bump to main.
2. Tag that commit `vX.Y.Z` (a version with `-` publishes under the `beta` tag, otherwise `latest`) and push the tag. A tag that is not on main fails in the first job, before the approval step.
3. When the run reaches `publish`, approve it in the Actions tab.

## If publish fails

- **`npm error 404 Not Found - PUT https://registry.npmjs.org/@khubaibqaiser%2fharness`.** npm rejected the trusted publisher. Usually the npmjs.com config expired (step 6 above) or a name doesn't match: the repository, `release.yml` or `npm-release`. Redo steps 4–6, then push a new tag for the next version. npm never accepts the same version twice.
- **GitHub Packages or the GitHub release failed, but npm succeeded.** Re-run just the failed job from the Actions tab. Each job only reads the tag, so a re-run is safe.

Installing from GitHub Packages needs a GitHub token even for a public package, so the README points users to npm. The GitHub copy is a mirror that shows the package on the repo page.

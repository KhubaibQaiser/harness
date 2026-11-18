# Releasing

Pushing a `v*` tag runs `.github/workflows/release.yml`:
1. It checks that the tag equals the `package.json` version, that the tagged commit is on main, and that `docs/release-notes/<version>.md` exists.
2. It runs CI.
3. It publishes to npm with provenance. This job runs in the GitHub environment `npm-release`, so it waits for a required reviewer.
4. After npm succeeds, two jobs run, both using GitHub's built-in token (no stored secrets):
   - one publishes the same version to GitHub Packages, so it shows under Packages on the repo page;
   - one creates a GitHub release from the release notes, marked as a pre-release for versions with `-`.
5. Until the first stable version, a prerelease also moves npm's `latest` tag, because `npm i` and `npx` with no tag install `latest`. It never moves `latest` backwards or off a stable version. If npm refuses, the job fails and says to enable "Allow npm dist-tag" (setup step 5).

## One-time setup (owner)

1. In the GitHub repo, open Settings, then Environments, then New environment. Name it `npm-release`.
2. Under Required reviewers, add yourself. Leave "Prevent self-review" off: you push the tag and are the only reviewer, so turning it on would lock you out.
3. Optional: under Deployment branches and tags, add a tag rule `v*`, so only release tags can deploy to this environment. (Environments need a public repo or a paid plan.)
4. On npmjs.com, open the package's Settings, then Trusted publisher. npm can't edit an existing connection: delete the old one and create a new one for GitHub Actions with this repository, the workflow `release.yml`, and the environment `npm-release`. The name must match exactly; npm doesn't check it when you save.
5. Under allowed actions, tick `npm publish` and "Allow npm dist-tag". The release job runs both. Moving a dist-tag over trusted publishing needs npm 11.21.0 or newer; the job pins it.
6. A new trusted-publisher config expires if no publish succeeds within 2 days. Push the first release tag, and approve it, within that time, or create the config again.

## Each release

1. Before the bump, run `pnpm audit` with devDependencies included (not `--omit=dev`): esbuild bundles them into `dist/`, so a devDependency advisory ships.
2. Merge the version bump to main. It changes `package.json` and `.claude-plugin/plugin.json`, adds `docs/release-notes/<version>.md` and updates the README status line. It leaves `.claude-plugin/marketplace.json` on the previous version: the plugin marketplace reads main, so a pin npm doesn't have yet would make `claude plugin install harness@harness` fail. A test allows the pin to be this version or exactly one release behind, never ahead.
3. Tag that commit `vX.Y.Z` (a version with `-` publishes under the `beta` tag, and also moves `latest` while there is no stable version; otherwise `latest`) and push the tag. A tag that is not on main fails in the first job, before the approval step.
4. When the run reaches `publish`, approve it in the Actions tab.
5. After npm has the version (`npm view @khubaibqaiser/harness@<version> version` prints it), open a small follow-up PR that moves the version in `.claude-plugin/marketplace.json`, and merge it. Plugin installs get the new version from then on.
6. Check `npm view @khubaibqaiser/harness dist-tags`: while there is no stable version, `latest` must name this release. If the job couldn't move it, run `npm dist-tag add @khubaibqaiser/harness@<version> latest` yourself.

## Known advisories

- **picomatch 4.0.7, [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)** (ReDoS through repeated extglobs, `<=4.0.7`, no patched version). It is a devDependency, but esbuild bundles it into `dist/`, so it ships. Harness never compiles a risky glob from agent text (`riskyGlob` in `src/core/paths.ts`; see the known limit in `docs/reference.md`). When a fixed version ships, bump it and keep the cap. `pnpm audit` keeps reporting this advisory until then.

## If publish fails

- **`npm error 404 Not Found - PUT https://registry.npmjs.org/@khubaibqaiser%2fharness`.** npm rejected the trusted publisher. Usually the npmjs.com config expired (step 6 above) or a name doesn't match: the repository, `release.yml` or `npm-release`. Redo steps 4–6, then push a new tag for the next version. npm never accepts the same version twice.
- **Re-running the release.** A re-run is safe. The publish step first asks npm whether this version exists. If it was published from this same commit, it skips `npm publish` and succeeds, so the GitHub Packages and GitHub release jobs still run. Each of those two jobs also skips itself when its package version or release already exists, so you can re-run the whole workflow, or just a failed job, from the Actions tab.
- **A failed publish blocks the next bump.** The versions test allows the marketplace pin to be exactly one release behind, and it reads "the release before" from `docs/release-notes/`. So once a version's notes are on main, retry that same version (re-run the workflow, or fix the cause and re-run) until npm has it, before you bump again. Skipping it would leave the next bump needing a pin npm doesn't have.
- **Version clash.** If the version is already on npm from a different commit (or npm has no commit for it), the publish step fails with "version X is already on npm from commit Y; bump the version". Bump `package.json`, add its release notes, merge to main, then tag the new version.

Installing from GitHub Packages needs a GitHub token even for a public package, so the README points users to npm. The GitHub copy is a mirror that shows the package on the repo page.

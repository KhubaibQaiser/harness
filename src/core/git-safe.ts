// A repo's own .git/config must not make harness's git calls run a program. Every git spawn starts with SAFE_GIT
// (SAFE_GIT_USER for `harness git`); every `git diff` adds SAFE_DIFF. `-c` reaches child git processes too (GIT_CONFIG_PARAMETERS).
// --no-optional-locks (git 2.15+) keeps status from writing the index back; `git diff <rev>` still writes it, so the
// post-index-change hook is turned off by pointing core.hooksPath at a directory that cannot exist.
// ponytail: filter.<x>.clean/smudge/process still run when status/diff/add must hash a worktree file. Blanking them
// would break git-lfs (every LFS file shows as changed, add would commit raw content), and driver names are per repo.
// SAFE_GIT_USER keeps hooks, and nothing here touches credential helpers, core.sshCommand or gpg signing: `harness git`
// checkout/commit/push are steps the person runs in their own repo and expects them. Upgrade if a hook ever runs those.
export const SAFE_GIT_USER = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];
export const SAFE_GIT = [...SAFE_GIT_USER, '-c', 'core.hooksPath=/dev/null/harness-no-hooks'];
export const SAFE_DIFF = ['--no-ext-diff', '--no-textconv'];

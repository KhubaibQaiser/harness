// A repo's own .git/config must not make harness's git calls run a program. Every git spawn starts with SAFE_GIT;
// every `git diff` adds SAFE_DIFF. `-c` reaches submodule git processes too (GIT_CONFIG_PARAMETERS).
// ponytail: filter.<x>.clean/smudge/process still run when status/diff/add must hash a worktree file. Blanking them
// would break git-lfs (every LFS file shows as changed, add would commit raw content), and driver names are per repo.
// Hooks, credential helpers, core.sshCommand and gpg signing stay on for `harness git` checkout/commit/push: the
// person ran those steps in their own repo and expects them. Upgrade if harness ever runs those from a hook.
export const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];
export const SAFE_DIFF = ['--no-ext-diff', '--no-textconv'];

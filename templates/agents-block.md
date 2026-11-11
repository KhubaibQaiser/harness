<!-- harness:start -->

## Harness workflow

Hooks enforce these rules. When a hook blocks or asks, its message names the next step; do that step.

### TDD

1. Write a failing test first. Refactors need a failing test too.
2. Run it and see it fail.
3. Implement the smallest change that passes.
4. Run the tests again.

Do not weaken or delete a test to make it pass; fix the code.

### Scope

- Before editing a second source file in one turn, list the files you plan to change. Test files don't count. The user is asked once per turn.
- In unattended runs, each extra file needs a line "<file> because <reason>" before it is edited.
- Installs are denied by default: ask the user to run them. When the user allows installs, JS package names are checked on the npm registry and the user approves each one.

### Protected paths

- Never edit `.harness/`, `.claude/settings*.json`, `.claude/rules/harness-decision-*.md` or harness decisions in `docs/decisions/`.
- Team decisions live in `docs/decisions/` and load as `.claude/rules/harness-decision-*.md` when you touch their paths. Change them only with `/harness:remember` (`harness remember --help`); personal preferences go in Claude Code's auto memory.
- Only a person can pause TDD, by running `harness tdd off` in their own terminal.

### Finishing

- The Stop gate runs the configured checks. If it blocks, fix the failure and finish again.

<!-- harness:end -->

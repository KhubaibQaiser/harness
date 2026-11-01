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
- Before editing a second file in one turn, list the files you plan to change. The user is asked once per turn.
- Add a dependency only after checking it exists and is the right one.

### Protected paths
- Never edit `.harness/` or `.claude/settings*.json`.
- Only a person can pause TDD, by running `harness tdd off` in their own terminal.

### Finishing
- The Stop gate runs the configured checks. If it blocks, fix the failure and finish again.
<!-- harness:end -->

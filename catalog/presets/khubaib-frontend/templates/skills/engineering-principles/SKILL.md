---
name: engineering-principles
description: 'Design principles and general JS/TS anti-patterns for this repo (DRY by the rule of three, SOLID where it fits, KISS, YAGNI, type escapes, swallowed errors, god files, mutation). Use when designing, refactoring or reviewing code.'
---
# Engineering principles

Design principles and general JS/TS anti-patterns for this repo. Stack rules live in the frontend skills.

## Principles

- DRY by the rule of three: duplicate once, and extract on the third copy.
- Extract only when the copies change for the same reason.
- SOLID, classes included, only where it fits naturally: "Full solid incl classes but only where it fits naturally no forced enforcement".
- KISS: take the smallest change that fully solves the task.
- YAGNI: don't add features, options or abstractions nobody asked for.

## Anti-patterns

Type escapes:
- No `as` to silence a type error.
- No `@ts-ignore`.
- No unexplained `!`.
- No untyped `JSON.parse`.
- Type untrusted values as `unknown`, then narrow them before use. [docs: https://www.typescriptlang.org/docs/handbook/2/functions.html#unknown]
- When a suppression is unavoidable, use `// @ts-expect-error`. It reports when the error is gone. [docs: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-9.html]
- `!` doesn't change runtime behaviour. Use it only when the value can't be null or undefined. [docs: https://www.typescriptlang.org/docs/handbook/2/everyday-types.html]

Swallowed errors:
- No empty catch, and no catch that only logs.
- No unhandled promises.
- No missing `await`.

God files and functions:
- No huge modules or long functions.
- No boolean-flag parameters.
- Use early returns, not deep nesting.

Mutation and magic:
- Don't mutate arguments or shared state.
- No magic numbers or strings.
- Use union types where they fit, not enums.

# What the toolchain still owes

Items move here from the repositories that take the toolchain; each names who asked and what closes it.

## The testing library

- **Mutation testing on TypeScript 7.0.2** (from grizzle's TODO, pantry's test survey, 2026-11-14): `src/mutants.ts`
  and `scripts/mutate.ts` import `typescript/ast`, `typescript/fs` and `typescript/sync`, which TypeScript 7.0.2
  (qti-pie's override) exports only under `./unstable/`, so no one can mutation-test qti-pie. Stable import paths fix
  it, or qti-pie moves to TypeScript 7.1.
- **A repetition cap for `pattern`'s `matching`** (pantry's ask): it refuses unbounded `*`, `+` and `{n,}`, so pantry
  rewrites them by hand (lexical-harness.ts:829 and :1013).
- **The set-comparison cost bound in `oracle.test.ts` reads a bare constant** (8·n·log n): read the ratio of the
  costs at n, 2n and 4n instead, as grizzle's growth gates are to.
- **Profile `consumer.test.ts`**: it is the one suite of the library not yet profiled.
- **A steered failure's replay may not reproduce the aimed case** (grizzle, restated 2026-11-12): when a search fails
  in its steered phase, the case it reports after shrinking may be the plain drawn case rather than the aimed one that
  failed, so its `TEST_REPLAY` token can pass alone. grizzle's 2fc93548 puts the aim in the token's steering field
  (`mask.aimHex`); no test yet proves that a replay of a steered failure fails again.

## Decisions recorded

- **no-raw-sql reads `packages/testing/src` only** (2026-11-14). grizzle listed its dev tools among the rule's sources,
  when they held no SQL rules. Here the dev tools hold the drizzle pack, whose rules read SQL text by design (they lint
  it), so their code is not code that must print SQL from an AST, which is what the rule guards.

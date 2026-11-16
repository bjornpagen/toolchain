# @bjornpagen/limits

The toolchain's own limits: every number the dev tools and the testing library bound something by, each a `Limit` of
`@bjornpagen/limit` with its evidence. The limits skill (`packages/devtools/skills/limits/SKILL.md`) is the policy;
this is where the toolchain keeps it.

- `src/limits.ts` holds every mint. Nothing else in the repository calls `published`, `measured`, `derived` or
  `provisional` (`devtools/limits-sole-mint`), and nothing else writes a bound as a bare number
  (`devtools/no-bare-limit`); code imports a limit and reads `.value`.
- `limits.env` holds the limits a shell script reads, one `NAME=value` line each, generated from them by
  `pnpm --filter @bjornpagen/limits limits:data` (`src/data.ts`). `pnpm check` runs `limits:check`, which refuses the
  file when it differs; commit it with any change to the limits it carries. `packages/devtools/bin/gate.sh` reads it
  for `GATE_LOCK_POLL_SECONDS`.
- Test files (`*.test.ts`, `*.test.tsx`, `*.fixtures.ts`, and `test/`, `tests/` and `fixtures/` directories) are exempt
  from both rules; `bench` files are not.

Before you add a limit here, ask the skill's first question: should it exist at all? Most of what this package holds
is provisional, a cap that guards something it names (in `breaks`) with no evidence yet and a plan to get some (in
`measure`). Paying one down means running its `measure` and minting the result as `measured` or `published`.

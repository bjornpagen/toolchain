# Contributing to the toolchain

The toolchain is four workspace packages, `@bjornpagen/devtools`, `@bjornpagen/testing`, `@bjornpagen/limit` (the
Limit and its mints) and `@bjornpagen/limits` (the toolchain's own limits), which every repository takes as the
submodule `vendor/toolchain`. This file says how the checks run, here and in every repository that takes
the toolchain; README.md says what a repository changes to take it.

## When each check runs

| When                                | Command                   | What runs                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each commit (lefthook's pre-commit) | `toolchain-gate commit`   | On a snapshot of what the index holds, side by side: `oxfmt --check` of the staged files and the AST-only oxlint on the staged JavaScript and TypeScript files. No typecheck, and no lint builds a TypeScript program. The target is 10 seconds or less.                                                                                                      |
| Each push (lefthook's pre-push)     | `toolchain-gate push`     | On a snapshot of each commit the push sends, in each package with a `test.config.ts`, `toolchain-test affected`: every property with no cached pass, and its kills, at full width (below). No typecheck and no `pnpm check`.                                                                                                                                  |
| Every 10 minutes, on main           | `pnpm check`              | The full gate (the typecheck from scratch, the type-aware oxlint, the format check, dead code, the lockfile's dedupe, the repository-wide checks and the fixtures) on origin's main once changes are on it, run by grizzle main's timer (Bjorn, 2026-11-16: "a global 10 minute typecheck across the same main that all the subagents are working on"). A red is fixed forward by the commit that made it. |
| On the consumer's schedule          | `toolchain-test fuzz`     | The scheduled fuzz budget, in each package root its own scheduler names: fresh seeds round after round until a case fails or the budget (`1h`, `100000x`) is spent. Never in a hook.                                                                                                                                                                          |
| By hand                             | `pnpm check`, `pnpm test` | The full gate over the working tree, and the tests; no hook runs either.                                                                                                                                                                                                                                                                                      |

Type-aware lint stays out of the commit: no tool caches its results (not tsgolint, not `tsrs --lint`, not oxlint), so
it would build every package's program on every commit, while a commit holds `.git/index.lock` for its whole hook. The
push's full gate runs it, and its non-incremental typecheck is the safety net for the open incremental stale-result
bugs of TypeScript (#64386, #64591).

Never commit or push with `--no-verify` in a shared checkout: the gates check exactly what you send, so a red gate is
your commit's.

## The root typecheck trap

`pnpm typecheck` at the root checks the root's own project only: `tsconfig.json` includes `oxlint.config.ts` and
`toolchain.config.ts` and whatever they import, under the root's settings, and no package's tests or scripts under the
package's. Run `pnpm types`. The root's script keeps the name `typecheck` because turbo runs it as `//#typecheck`, the
root's part of `pnpm types`.

## Incremental typecheck

The shared base, `packages/devtools/tsconfig.base.json`, sets `incremental: true` and
`tsBuildInfoFile: ${configDir}/node_modules/.cache/typecheck.tsbuildinfo`, and keeps `noEmit`. `${configDir}` is the
directory of the tsconfig being checked, so each package, and the root, keeps its own build info, under a
`node_modules/` every repository already ignores, which pnpm leaves alone on install.

The build info is no turbo output. A turbo hit replays the diagnostics and needs no build info; a miss reads whatever
build info the directory holds, and tsrs proves it against the files' hashes and the options, the Effect plugin's
included, so any build info is safe to start from. Caching it would store a new copy, megabytes in a large package, for
every content change. Nothing else writes it: oxlint's tsgolint reads the tsconfig but emits nothing.

`typecheck:full` is a turbo task of its own, so the push's typecheck never replays a hit of the incremental one.

Every package's scripts are:

```json
"typecheck": "toolchain-typecheck",
"typecheck:full": "toolchain-typecheck --incremental false",
"oxlint": "toolchain-oxlint"
```

and the root adds `"types": "turbo run typecheck"` and runs `typecheck:full` in `check` in place of `typecheck`.

## oxlint: the two configurations

`oxlint.config.ts` is the full configuration, with type-aware rules (`options.typeAware: true`), and runs in
`pnpm check`. `oxlint.ast.config.ts`, beside it, is the same configuration through the preset's `astOnly`: no
type-aware rule, every rule of the built-in plugins and the JavaScript plugins (the toolchain's, the testing library's
and the repository's own), which read syntax and scope only, since a JavaScript plugin gets no type information.

How oxlint picks a configuration, checked on oxlint 1.93.0:

- With no `-c`, oxlint reads the nearest `oxlint.config.ts` (or `.oxlintrc.json`) from the directory it runs in
  upward, and a nested configuration file applies beneath its directory. So a package's `oxlint` task, which runs in
  the package, takes the root's `oxlint.config.ts`.
- `-c <file>` reads that file alone: nested configuration files are not read.
- A configuration's JavaScript plugins resolve from the configuration file's directory, so the AST-only configuration
  must sit at the root beside the full one.
- With `typeAware: false`, oxlint skips every type-aware rule without a word and never starts tsgolint.
  `--type-aware` on the command line turns them back on, so the commit gate never passes it.
- A path that the ignore patterns exclude is skipped; when nothing is left, oxlint fails ("No files found to lint")
  unless it is given `--no-error-on-unmatched-pattern`, which the commit gate passes.

The exact commands:

| Run                  | Command                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| Full, one package    | `toolchain-oxlint` in the package (its `oxlint` task)                              |
| Full, every package  | `pnpm exec turbo run oxlint`, which `pnpm check` runs                              |
| AST-only, some files | `pnpm exec oxlint -c oxlint.ast.config.ts --no-error-on-unmatched-pattern <files>` |

## Where a rule goes

No check builds a TypeScript program but the typecheck: superlint, which built one per package, is retired, and the
style linter and the workspace gate read files as text. A new rule goes, in this order of preference:

- to an Effect diagnostic or a TypeScript option, when the compiler can own it;
- to oxlint's built-in rules, turned on in the preset (`packages/devtools/src/preset.ts`), with their type-aware rules
  among them (tsgolint runs those in `pnpm check` only);
- to the devtools oxlint plugin (`packages/devtools/src/oxlint/rules/`), reading one file's syntax and scopes, with
  its `clean.tsx` and `violating.tsx` fixtures under `src/oxlint/fixtures/<rule>/`, its fixture options in
  `src/oxlint/fixture-rules.ts` and its place in the preset's `PLACES` (a rule that judges a file by its path, as the
  limit rules do, also proves its paths on RuleTester, as `src/oxlint/limit-cases.ts` does); a rule for one repository only goes to that
  repository's own plugin (`ownPlugin`);
- to the workspace gate (`packages/devtools/src/workspace/`), when it reads the repository's JSON or file names;
- to the testing library's reporter, when it judges what a test did at run time.

A rule that needs the checker and fits none of these is a decision for the owner, not a new program.

The SQL rules know Drizzle by import (`src/oxlint/drizzle.ts`): a `sql` template is Drizzle's when the file imports
its tag from drizzle-orm, by name, renamed or off a namespace import. `devtools/no-raw-sql` reads those templates and
nothing else: a `::` cast in one, outside its quoted strings and identifiers, comments and dollar-quoted bodies, as
PostgreSQL's scanner reads the text Drizzle sends, is reported outside the rule's `writers`. A string literal, an
untagged template or another tag's template is never SQL to it, so a `::` in a regular expression, an ARN or prose
passes.

## Effect diagnostics

The shared base lists every diagnostic the installed @effect/tsgo ships (the workspace gate's diagnostic-roster), each
at `"error"`, but those the toolchain drops for every repository, which it lists at `"off"`: `DROPPED_DIAGNOSTICS` in
`packages/devtools/src/workspace/tsconfigs.ts`, each with its reason. Every tsconfig that restates the plugin sets a
dropped diagnostic off and each of the repository's own rejections (`toolchain.config.ts`'s `rejected.diagnostics`)
off, and every other diagnostic to error, which the gate's rejected-diagnostics holds. Dropping a diagnostic for every
repository is the owner's decision, as a repository's rejection is.

`missingConcurrencyOption` is dropped (Bjorn, 2026-11-14): it demanded a `concurrency` option on every `Effect.forEach`
and `Effect.all`, so code stated `{ concurrency: 1 }`, the default, to please it. Write no concurrency where the run is
sequential; a wider one is a limit, and it answers to the limits below.

## The gate: snapshots

`toolchain-gate` (`packages/devtools/bin/gate.sh`) runs a check on exactly one snapshot of the repository, never on the
working tree, so lanes that share one checkout never fail or pass each other's work in progress:

- `toolchain-gate commit` is the commit gate; `toolchain-gate push`, with lefthook's `use_stdin`, is the push gate,
  which reads the commits a push sends from git's pre-push lines; `toolchain-gate run <index|commit> <command>` runs
  any command on what the index holds or on a commit (`toolchain-gate run index pnpm check` is the old
  `scripts/check-staged.sh`).
- A snapshot is a directory under `${XDG_CACHE_HOME:-~/.cache}/toolchain-gate/<the repository's key>/` (the cache layout
  is below) that git keeps in
  step with an index of its own (`read-tree --reset -u`): a run rewrites only the files that changed, deletes the ones
  that went, and keeps what `.gitignore` names (node_modules, the build info, the tools' caches), so the install and
  the incremental typecheck stay warm. It installs with `pnpm install --frozen-lockfile --offline`, so a lockfile
  change must be installed in the working tree first, which fills the store.
- git leaves a submodule's gitlink an empty directory; the gate fills each from the submodule's own repository at the
  commit the snapshot records, and leaves a submodule the working tree never checked out empty, as it is there.
- The commit gate and the push gate keep separate snapshots, so a commit, which holds `.git/index.lock` for its whole
  hook, never waits on a push's full gate. Runs on one snapshot take turns.
- Turbo's cache is the working tree's (`.turbo/cache`) unless `TURBO_CACHE_DIR` names one, so a task the working tree
  already ran on the same content is a hit in the snapshot, and the other way round.

The hooks call lefthook and the gate by path (`node_modules/.bin/lefthook`, `sh packages/devtools/bin/gate.sh`), not
through `pnpm exec`, whose dependency check refuses to run anything while another lane's manifest change waits for its
install.

### The cache layout

The cache is per repository, not per checkout: `${XDG_CACHE_HOME:-~/.cache}/toolchain-gate/<key>/`, where the key is the
first 12 hex digits of the git hash of the repository's identity, its origin remote URL when it has one, else its
absolute common git directory. Every clone of one repository (grizzle's lanes clone it under
`~/.cache/grizzle-release/<LANE>/`) shares one commit snapshot and one push snapshot and takes turns under the lock, so
a clone's first run is warm: the install and the typecheck's build info are already there.

| Path under `<key>/`        | What it is                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| `clones`                   | The common git directories of the clones that ran here, one a line.              |
| `commit`, `push`           | The snapshots' checkouts; `commit.git` and `push.git` are their git directories. |
| `commit.lock`, `push.lock` | A directory holding a pid file while a run uses the snapshot.                    |

A snapshot's git directory borrows objects (alternates) from one repository. Each run rewrites the alternates to the
objects of the clone whose commit it checks, under the lock and before `read-tree`: that clone is the only one certain
to hold the commit (the commit gate's commit of the index exists nowhere else), and the run holds the lock until it
exits, so no other clone's rewrite takes the objects away mid-run. The semantics are unchanged: `read-tree --reset -u`,
`git clean -fd` without `-x`, submodules filled from the checking clone's submodule repositories.

A run that enters the cache collects garbage: it deletes every other key directory none of whose listed clones still
exists with that key as its identity, unless a live run holds one of its locks. A directory with no `clones` file is
the old per-path layout and goes the same way (a hard cutover; nothing reads it). A clone moved or deleted therefore
costs its repository one cold snapshot at most, when the last clone is gone.

A snapshot directory is safe to delete when no gate is running; the next run builds it again.

## The push gate's properties: affected and the verdict cache

`toolchain-test affected <ref>` (`packages/testing/src/runner/affected.ts`) runs, in a package root, every property
whose verdict key holds no cached pass, at full width, then the kills of each that passed; a property passes when its
search passes and every kill of it turns its witnesses red, and only then is its pass cached. A cached pass is a known
answer: it never runs again. A failure removes the pass its key held. The push gate runs it after `pnpm check`, in each
package of the snapshot with a `test.config.ts`, against the commit the remote held (the empty tree for a new ref); the
ref only sorts the report's count of what ran into "changed since <ref>" and "not verified at this content".

A property's key is its identity, the closure hash of its module joined with those of the package's `test.config.ts`
and the runner's own entry modules (`runner/cli.ts`, `runner/worker.ts`), the seed policy of a gate run, and each kill
with the content hash of the file it mutates. A closure hash (`runner/closure.ts`) is the SHA-256 of everything a
module loads as Node loads it: every file reached through static imports, re-exports and dynamic imports of a literal
(never `import type` or `export type`, which Node erases), resolved by relative path, `imports` and `exports` maps under
Node's conditions and the config's, and workspace packages; each external package by its lockfile entry and those of
the packages it depends on; built-ins by name; the config's conditions and Node's version. Import cycles hash as one
unit. A specifier that resolves to nothing, an undeclared package or a key the lockfile lacks fails the command.

What a property reads without importing it, a fixture file read at run time or code a child process runs, is outside
its closure: the full run per production version, `toolchain-test run`, covers it. It reads no cached pass: every
property named runs, then the kills of each whose search passed, and every verdict is recorded, so a property whose
kills did not all turn red fails the run and is never a cached pass.

Verdicts live per repository, shared by every clone and the gate's snapshots (the push snapshot carries the
repository's origin URL so it names the repository as the clones do):

| Path                                                                                   | What it is                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<key>/verdicts/<property>/<key hash>.json` | One pass: `<property>` is the SHA-256 of the property id, `<key hash>` that of the key, and the file holds the key itself. A record whose text is not its key is refused and its property runs. `<key>` is the gate's key. |

A property keeps one record at most, its newest verdict's: every write collects the property's other records, so a
pass keeps only its own and a failure keeps none. What goes is decided by the key, never by an age. Writes go to a
temporary file beside the record and are renamed into place, so no lock is needed; a record a concurrent writer's
collection removes costs its property one run. A record is safe to delete at any time.

`toolchain-test fuzz <fuzztime>` runs each round at reach `rotating`: a property's rotating stream alone, under a fresh
seed, since its kept tokens, floor and steered phase are the same on every seed and every run and push checks them.

## Turbo's cache

Never set `cacheDir` in turbo.json: a machine-wide `TURBO_CACHE_DIR` (which the gate passes on) is what lets clones
share one cache.

## Limits

Every number that bounds something, here and in every repository, answers to the limits skill
(`packages/devtools/skills/limits/SKILL.md`, linked as `.agents/skills/limits`), which keeps the indefensible-numbers
policy. Its first question is whether a cap should exist at all: one that guards nothing named is deleted, not minted.
What stays is a `Limit` of `@bjornpagen/limit`, `published`, `measured`, `derived` or `provisional`, minted in the
repository's own limits package and read by its `.value`.

The toolchain's own limits are `@bjornpagen/limits` (`packages/limits/src/limits.ts`); its README lists what it holds.
Two rules of the devtools plugin hold that by syntax, in the limits pack (`limits()` in `toolchain.config.ts`), with
`{ packages: ["packages/limits"], tests: LIMIT_TESTS }` as their options in `oxlint.config.ts`:

- `devtools/no-bare-limit` refuses a numeric literal in a governed place outside the limits package: a value whose
  name carries bound vocabulary, a Duration, Schedule or Effect time or count, a semaphore's permits, a timer's delay, a
  duration as text. The not-a-limit list passes where syntax shows it.
- `devtools/limits-sole-mint` refuses a call of a mint of `@bjornpagen/limit` outside the limits package.

Test files (`*.test.ts`, `*.test.tsx`, `*.fixtures.ts`, and every `test/`, `tests/` and `fixtures/` directory) are exempt
from both; `bench` files are not. An exception is an override block in `oxlint.config.ts` with its reason: the engine
bench's is the only one, since its generator ranges are its workload.

A shell script reads a limit from `packages/limits/limits.env`, which `src/data.ts` generates from the Limits
(`pnpm --filter @bjornpagen/limits limits:data`); `limits:check`, in `pnpm check`, refuses the file when it differs.
`bin/gate.sh` reads its lock poll and its daily check:full period there.

A number the machine reports is read where it is used, never minted, and widths computed from it are no limit:

| Width                                              | Where                                     | What it is                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test processes at once, `testWorkers`              | `packages/testing/src/workers.ts`         | what the machine reports, `availableParallelism()`: one forked test process a logical CPU                                                                                                                                                                         |
| Workers one mutant's trial leases                  | `packages/testing/src/mutate/schedule.ts` | `shareOf`, a plain function of the pool's width (`testWorkers`) and the trials of a run: the width split evenly among them, at least one each, so the trials at once never lease more workers than one test run holds                                             |
| turbo's tasks at once, `"concurrency": "100%"`     | `turbo.json`                              | one task a logical processor; turbo documents `100%` as "all available logical processors" and 10 tasks as its default (https://turborepo.dev/docs/reference/configuration, verified 2026-11-15). JSON carries no comment, so this row is its documentation       |
| One gate run per snapshot                          | `bin/gate.sh`                             | an identity: a snapshot is one directory that a run rewrites                                                                                                                                                                                                      |
| A search's cases at once, a search's `concurrency` | each test's `explore` or `exhaust`        | left out, one at a time (`oneAtATime`), an identity; stated above one, the test's own input, no resource's bound: the engine finds the same cases at any concurrency, and a sense that reads process-wide counters (guided coverage) runs its cases one at a time |

## Steering belongs to the generator

A search offers steering (the requirements still pending, the one a case's turn aims at) to its generator alone:
`Draw`'s `generator` is a `Steered`, and `runRecorded` draws `generator(under.steering)`. A `Case` never carries
steering, so no property can run a case other than the sketch the search prints, shrinks, keeps and replays. Keep it
that way: a new phase or search passes its steering to the generator through `Under`, a replay draws under its token's,
a shrink under its case's own, and a kept case is its sketch, drawn by nothing. `exhaust` steers nothing; its space is
its box. The aimed-case property in `explore.test.ts` holds this, and its kill is the bug it catches.

## Kills

A bug a property must catch is a kill on that property (`Kill` in `packages/testing/src/property.ts`): a file from the
repository root, an original that stands exactly once in it, the replacement that breaks the code as the bug would, and
why the property goes red. With a kill applied, the property's witness cases (its floor and steered phase, or an
exhaustion's every case) must fail. A kill whose original no longer stands once in its file is stale: make it again
against the code as it is, on the property that catches it. A kill that leaves its property green is a bug no property
catches: it stays on the property, never quietly off it.

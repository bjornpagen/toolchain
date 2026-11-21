# Contributing to the toolchain

The toolchain is two workspace packages, `@bjornpagen/devtools` and `@bjornpagen/testing`, which every repository
takes as the submodule `vendor/toolchain`. This file says how the checks run, here and in every repository that takes
the toolchain; README.md says what a repository changes to take it.

## When each check runs

| When                       | Command                   | What runs                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After every edit           | `pnpm types`              | `turbo run typecheck`: each package's and the root's typecheck, from scratch: it reads no build info, and turbo replays a package whose inputs did not change at all.                                                                                                                                                                                                                                                  |
| Each landing (`pnpm land`) | `toolchain-land`          | From a jj workspace onto the repository's hub (the remote `hub`), behind the thin gate: `jj fix` with the repository's oxfmt on the files the landing changes, the lockfile against the manifests, the repository's `land:generated` where it has one, `pnpm types`, and the test files the landing adds or changes, by path. A landing whose push the hub refuses because its trunk moved lands again from the fetch. |
| Each batch on the hub      | `pnpm trunk`              | `trunk@<repo>` runs the root's `trunk` script in a worktree of the hub's trunk, then pushes upstream only what passed: `pnpm check`, then, in each package with a `test.config.ts`, `toolchain-test affected origin/main` (upstream's main): every property with no cached pass, and its kills, at full width (below).                                                                                                 |
| On the consumer's schedule | `toolchain-test fuzz`     | The scheduled fuzz budget, in each package root its own scheduler names: fresh seeds round after round until a case fails or the budget (`1h`, `100000x`) is spent. Never in a hook.                                                                                                                                                                                                                                   |
| By hand, never in a lane   | `pnpm check`, `pnpm test` | The full gate over the working tree, and the tests: trunk's, not a lane's.                                                                                                                                                                                                                                                                                                                                             |

Type-aware lint stays out of a landing: no tool caches its results (not `tsrs --lint`, not oxlint), so it would build
every package's program on every landing. Trunk's whole gate runs it, once a batch.

## The root typecheck trap

`pnpm typecheck` at the root checks the root's own project only: `tsconfig.json` includes `oxlint.config.ts` and
`toolchain.config.ts` and whatever they import, under the root's settings, and no package's tests or scripts under the
package's. Run `pnpm types`. The root's script keeps the name `typecheck` because turbo runs it as `//#typecheck`, the
root's part of `pnpm types`.

## A typecheck from scratch

toolchain-typecheck reads no build info: TypeScript 7.1.0-beta's incremental check, tsgo's and tsrs's alike, passes
code a check from scratch refuses. Once build info holds a file that uses an imported type, the file's next version,
whose last use of the type moved into the inferred type of an export, passes with the import unused (TS6196), and the
gate's snapshots, which every clone shares, held build info another tree wrote (METIS-BOOT, 2026-11-20: an unused
`import type` passed metis's commit and push gates). The shared base, `packages/devtools/tsconfig.base.json`, sets no
`incremental`, and toolchain-typecheck hands tsrs a build info file in a directory of the run's own, removed when it
ends (`--tsBuildInfoFile`, after every argument it is given), so a composite project, which TypeScript keeps
incremental whatever it is told, reads none either. Build mode (`-b`), which reads build info to skip the projects it
judges up to date, is refused: a composite project is checked with `-p`, against the declarations its references'
checks wrote. turbo still replays every package whose inputs did not change, so `pnpm types` costs a whole check of the
packages that changed and nothing for the rest.

Every package's scripts are:

```json
"typecheck": "toolchain-typecheck",
"oxlint": "toolchain-oxlint"
```

and the root adds `"types": "turbo run typecheck"` and runs the same task in `check`. The
root's own `"oxlint"` is `"toolchain-oxlint-root"`: oxlint over the paths the root tsconfig's `include` names, the same
list its typecheck reads, so the root's files are named once. turbo.json registers `//#typecheck`
and `//#oxlint`, since turbo runs a root script for no generic task; the workspace gate's `root-tasks` and `root-files`
rules refuse a root script turbo would skip, a root TypeScript file the include does not name, and a root `oxlint`
script that is not the root lint.

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
- oxlint runs the type-aware rules in the first `tsrs-lint` or `tsgolint` it finds: `OXLINT_TSGOLINT_PATH`, then each
  `node_modules/.bin` from the directory it runs in upward, then `PATH`, `tsrs-lint` first in each place. The root
  lists the tsrs package, whose `tsrs-lint` is `tsrs --lint`, and no `oxlint-tsgolint`.
- With `typeAware: false`, oxlint skips every type-aware rule without a word and never starts `tsrs-lint`.
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
  among them (`tsrs --lint` runs those in `pnpm check` only);
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

## No hooks: the landing and trunk

No repository runs git hooks: jj runs none, and lefthook, which installed them, is gone (its install wrote hooks into a
hub's bare repository, where its pre-push dies with "this operation must be run in a work tree" and failed trunk@den's
push upstream, 2026-11-21). The toolchain's gate (`toolchain-gate`, the hooks' snapshots of what each commit and push
let through) went with them. A lane lands with `pnpm land` (`packages/devtools/bin/land.sh`) on the repository's hub
behind the thin gate (the formatter, the lockfile, the typecheck and the test files it changes), and `trunk@<repo>` runs
the root's `trunk` script, the whole gate, in its own worktree of exactly the commit it gates, on a batch of landings,
before it pushes upstream.

## A lane's properties: affected and the verdict cache

`toolchain-test affected <ref>` (`packages/testing/src/runner/affected.ts`) runs, in a package root, every property
whose verdict key holds no cached pass, at full width, then the kills of each that passed; a property passes when its
search passes and every kill of it turns its witnesses red, and only then is its pass cached. A cached pass is a known
answer: it never runs again. A failure removes the pass its key held. A lane runs it against the trunk it lands on, in
each package with a `test.config.ts`; the ref only sorts the report's count of what ran into "changed since <ref>" and
"not verified at this content". Trunk runs every property in full, `toolchain-test run`, reading no cached pass.

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
property named runs, then the kills of each whose search passed (save those whose verdict the cache holds), and every
verdict is recorded, so a property whose kills did not all turn red fails the run and is never a cached pass.

Verdicts live per repository, shared by every clone and workspace of it, which name the repository by its origin URL:

| Path                                                                                   | What it is                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<key>/verdicts/<property>/<key hash>.json` | One pass: `<property>` is the SHA-256 of the property id, `<key hash>` that of the key, and the file holds the key itself. A record whose text is not its key is refused and its property runs. `<key>` is the repository's key: the first 12 hex digits of the git hash of its origin URL, with no trailing `/` or `.git`, else of its common git directory. |

Records are content-addressed and immutable: every pass stays under its own key, so lanes that push different trees one
after another find each other's passes, and a failure removes only the pass under its own key. Nothing is collected by
age or by property; a record whose closure no live tree can produce is the only kind a collection may remove. Writes go
to a temporary file beside the record and are renamed into place, so no lock is needed. A record is safe to delete at any
time.

A kill's verdict is a record of the same cache: its key is the property's joint closure, the kill with the content hash
of the file it mutates, and the kill gate's seed policy. A kill that turned its property red is a known answer that
`run`, `affected` and `kills` do not judge again; a changed property, kill or file makes its key new.

### Properties that need a database

The testing library's database resources (`@bjornpagen/testing/resources`) are proven against a real PostgreSQL:
`packages/testing/test.config.ts`'s layer provides their cluster (`resources.fixtures.ts`), the testing package's own
local cluster (`packages/testing/pg.config.ts`: port 5441, the server the `pg_config` on PATH names), which the layer
makes and starts the first time a case opens a need, as every repository's cluster is made (`src/pg`). No environment
is needed: a push whose change reaches `src/resources/resources.test.ts`'s closure brings the cluster up itself. From
`packages/testing`, `pnpm pg <command>` runs its life by hand (`pnpm pg doctor`, `pnpm pg destroy`).

The properties make databases only under the prefix `tc_` (templates `tc_tpl_<digest>`, clones `tc_c_<owner>_<n>`)
and, for the property about collection, a prefix of each case's own (`tcs<hex>_`); each case drops what it made, and
`collect` (`resources/collect.ts`) drops what an ended or killed run left under `tc_`. A run killed in the collection
property can leave `tcs<hex>_` databases, which go by hand (`DROP DATABASE ... WITH (FORCE)`, after `ALTER DATABASE ...
IS_TEMPLATE false` for a template).

`toolchain-test fuzz <fuzztime>` runs each round at reach `rotating`: a property's rotating stream alone, under a fresh
seed, since its kept tokens, floor and steered phase are the same on every seed and every run and push checks them.

## Turbo's cache

Never set `cacheDir` in turbo.json: a machine-wide `TURBO_CACHE_DIR` (which the gate passes on) is what lets clones
share one cache.

## Limits

Every number that bounds something, here and in every repository, answers to the indefensible-numbers skill
(`packages/devtools/skills/indefensible-numbers/SKILL.md`, linked as `.agents/skills/indefensible-numbers`). Its first
question is whether a cap should exist at all: one that guards nothing named is deleted. What stays is a plain constant
in the module that uses it, its evidence in its JSDoc: `@limitKind` `published`, `measured`, `derived` or
`provisional`, with `@owner`, `@unit`, `@scope` and the kind's tags. Review holds the policy; no rule does.

A shell script keeps its number as a `readonly` at its top with the same tags above it.

A number the machine reports is read where it is used, never minted, and widths computed from it are no limit:

| Width                                              | Where                                     | What it is                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test processes at once, `testWorkers`              | `packages/testing/src/workers.ts`         | what the machine reports, `availableParallelism()`: one forked test process a logical CPU                                                                                                                                                                         |
| Workers one mutant's trial leases                  | `packages/testing/src/mutate/schedule.ts` | `shareOf`, a plain function of the pool's width (`testWorkers`) and the trials of a run: the width split evenly among them, at least one each, so the trials at once never lease more workers than one test run holds                                             |
| turbo's tasks at once, `"concurrency": "100%"`     | `turbo.json`                              | one task a logical processor; turbo documents `100%` as "all available logical processors" and 10 tasks as its default (https://turborepo.dev/docs/reference/configuration, verified 2026-11-15). JSON carries no comment, so this row is its documentation       |
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

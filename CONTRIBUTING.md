# Contributing to the toolchain

The toolchain is two workspace packages, `@bjornpagen/devtools` and `@bjornpagen/testing`, which every repository
takes as the submodule `vendor/toolchain`. This file says how the checks run, here and in every repository that takes
the toolchain; README.md says what a repository changes to take it.

## When each check runs

| When                                | Command                   | What runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After every edit                    | `pnpm types`              | `turbo run typecheck`: each package's and the root's typecheck, from scratch: it reads no build info, and turbo replays a package whose inputs did not change at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Each commit (lefthook's pre-commit) | `toolchain-gate commit`   | On a snapshot of what the index holds, side by side: `pnpm types`, `oxfmt --check` of the staged files, and the AST-only oxlint on the staged JavaScript and TypeScript files. No lint builds a TypeScript program. The target is 10 seconds or less.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Each push (lefthook's pre-push)     | `toolchain-gate push`     | Every push, one sending a submodule's gitlink alone, deletions alone or an empty commit included (a lefthook script job, `.lefthook/pre-push/gate.sh`, below). `pnpm check` on a snapshot of the tip of each pushed ref: the typecheck, the type-aware oxlint, the format check, dead code, the lockfile's dedupe, the repository-wide checks and the fixtures; then, in each package with a `test.config.ts`, `toolchain-test affected`: every property with no cached pass, and its kills, at full width (below). A tree the gate passed before passes again at once (`push.passed/<tree>`), so push by sha (`git push --no-thin origin <sha>:main`) and never commit while a push is in its hook. |
| On the consumer's schedule          | `toolchain-test fuzz`     | The scheduled fuzz budget, in each package root its own scheduler names: fresh seeds round after round until a case fails or the budget (`1h`, `100000x`) is spent. Never in a hook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| By hand                             | `pnpm check`, `pnpm test` | The full gate over the working tree, and the tests, which no hook runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Type-aware lint stays out of the commit: no tool caches its results (not `tsrs --lint`, not oxlint), so
it would build every package's program on every commit, while a commit holds `.git/index.lock` for its whole hook. The
push's full gate runs it.

Never commit or push with `--no-verify` in a shared checkout: the gates check exactly what you send, so a red gate is
your commit's.

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

## The gate: snapshots

`toolchain-gate` (`packages/devtools/bin/gate.sh`) runs a check on exactly one snapshot of the repository, never on the
working tree, so lanes that share one checkout never fail or pass each other's work in progress:

- `toolchain-gate commit` is the commit gate; `toolchain-gate push`, with lefthook's `use_stdin`, is the push gate,
  which reads the commits a push sends from git's pre-push lines; `toolchain-gate run <index|commit> <command>` runs
  any command on what the index holds or on a commit (`toolchain-gate run index pnpm check` is the old
  `scripts/check-staged.sh`).
- A snapshot is a directory under `${XDG_CACHE_HOME:-~/.cache}/toolchain-snapshots/<the repository's key>/` (the cache layout
  is below) that git keeps in
  step with an index of its own (`read-tree --reset -u`): a run rewrites only the files that changed, deletes the ones
  that went and every other file the commit does not hold, what `.gitignore` names among them (an output another
  tree's check generated, which a check whose cache misses would read as this tree's), and keeps only the installed
  dependencies (node_modules) and the caches of turbo (.turbo) and fallow (.fallow), so the install stays warm. It
  installs with `pnpm install --frozen-lockfile --prefer-offline`, from
  pnpm's store and metadata cache, fetching only what they lack (the cache layout below).
- git leaves a submodule's gitlink an empty directory; the gate fills each from the submodule's own repository at the
  commit the snapshot records, and leaves a submodule the working tree never checked out empty, as it is there.
- The commit gate and the push gate keep separate snapshots, so a commit, which holds `.git/index.lock` for its whole
  hook, never shares one with a push's gate.
- No run waits for another. A mode has as many snapshots as runs of it were ever at once: a run claims the first one
  no live run holds and, when every one is held, makes the next at once, filled and installed from pnpm's store. A
  long command in one snapshot (a property suite run by hand, the push's affected properties) holds no other lane's
  commit or push: JUDGEGUARD's push waited 1,720 s behind another run's lock, then checked in 35.5 s.
- Turbo's cache is the working tree's (`.turbo/cache`) unless `TURBO_CACHE_DIR` names one, so a task the working tree
  already ran on the same content is a hit in the snapshot, and the other way round: `pnpm types` after the last edit
  makes the commit gate's `pnpm types` a replay.

The hooks call lefthook and the gate by path (`node_modules/.bin/lefthook`, `sh packages/devtools/bin/gate.sh`), not
through `pnpm exec`, whose dependency check refuses to run anything while another lane's manifest change waits for its
install. The push gate is lefthook's script job `.lefthook/pre-push/gate.sh`, not a run job: lefthook skips a pre-push
run job whenever `git diff HEAD @{push}` names no file, so a push of a submodule's gitlink alone, of deletions alone or
of an empty commit went out ungated (`gate (skip) no matching push files`), and it runs a script job whatever the push
changes.

### The cache layout

The cache is per repository, not per checkout: `${XDG_CACHE_HOME:-~/.cache}/toolchain-snapshots/<key>/`, where the key is the
first 12 hex digits of the git hash of the repository's identity, its origin remote URL when it has one, written with
no trailing `/` or `.git` (`https://github.com/o/r.git` and `https://github.com/o/r` are one repository, which keyed
two caches for grizzle until the gate wrote them alike), else its absolute common git directory. Every clone of one
repository (grizzle's lanes clone it under `~/.cache/grizzle-release/<LANE>/`) shares its snapshots, so a clone's first
run is warm: the install is already there.

A snapshot's install reads pnpm's own caches, the store and the package metadata, which every clone and snapshot on the
machine shares, and fetches only what they lack (`--prefer-offline`), never `--offline`: under pnpm 12's supply-chain
policy (`minimumReleaseAge`, the trust policy) any lockfile change has pnpm check the metadata of its packages again, so
an offline install failed with `ERR_PNPM_NO_OFFLINE_META` whenever the metadata cache lacked one of them, until someone
installed in the snapshot online by hand.

| Path under `<key>/`      | What it is                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `clones`                 | The common git directories of the clones that ran here, one a line.                                                         |
| `commit.<n>`, `push.<n>` | The snapshots' checkouts, numbered from 0; `<mode>.<n>.git` is each one's git directory.                                    |
| `<mode>.<n>.lock`        | Locked (flock(2), exclusive) by the run that uses that snapshot, and by every process it starts.                            |
| `push.full`              | Stamped when the daily `check:full` passed.                                                                                 |
| `push.passed/<tree>`     | Stamped when every check of the push gate passed on that tree: a push sending it again claims no snapshot and runs nothing. |

Beside each key directory, `.<key>.lock` is locked (flock(2), shared) by every run of the repository, from before its
first look at the cache (the push's stamps, a claim) until it and everything it started have exited, so whatever holds
a snapshot holds its key. Every hold is the kernel's lock on an open file, which the run's shell and everything it
starts keep open and which the kernel lets go of when the last of them exits, however it exits, taken on the shell's
descriptor by the toolchain's one holder of kernel locks (`packages/testing/scripts/hold.pl`, which takes the cluster
maker's lifecycle lock and a run's lease too; the gates since 434ec12 take the same locks with flock(1), so the two
keep each other's while repositories repin): no pid names a holder,
so a live run is never taken for a dead one, and no run reads a snapshot another is filling. A snapshot a killed run left half-filled is reset whole by the next run that claims it
(`read-tree --reset -u` rewrites every tracked file whose stat differs, and `clean` removes the strays).

A snapshot's git directory borrows objects (alternates) from one repository. Each run rewrites the alternates to the
objects of the clone whose commit it checks, while it holds the snapshot and before `read-tree`: that clone is the only
one certain to hold the commit (the commit gate's commit of the index exists nowhere else), and the run holds the
snapshot until it exits, so no other clone's rewrite takes the objects away mid-run. The semantics are unchanged: `read-tree --reset -u`,
`git clean -fd` without `-x`, submodules filled from the checking clone's submodule repositories.

A run collects garbage once it holds its key: it deletes every other key directory none of whose listed clones still
exists with that key as its identity, unless a run holds it. The `clones` registry only says whether a repository is
gone; whether a run is in its directory is the lock's to say: the collect takes the directory's lock alone, without
waiting, and renames the directory away under it, then removes it, so a run holds the key before the rename and the
directory stays, or makes a new one after it. That rename is the one way anything under the cache is deleted, but a
snapshot's own reset, which its claim's lock guards. A clone moved or deleted therefore costs its repository one cold
snapshot at most, when the last clone is gone.

The cache is this gate's alone. Every gate before it kept its snapshots in `${XDG_CACHE_HOME:-~/.cache}/toolchain-gate/`,
and its collect sees no flock(1) hold: it judged a directory by a pid file inside each lock and by a key that kept a
URL's `.git`, so the directory of a repository cloned with `.git` read as gone and was deleted under its live run
(effect-openapi-cli-generator's 930250a4b854, four pushes in a row on 2026-11-19, with `spawn /bin/sh ENOENT` and "No
package.json"). No older gate looks in `toolchain-snapshots/`. `toolchain-gate/` is dead weight once no repository on the
machine pins a toolchain older than this gate; delete it then.

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
property named runs, then the kills of each whose search passed (save those whose verdict the cache holds), and every
verdict is recorded, so a property whose kills did not all turn red fails the run and is never a cached pass.

Verdicts live per repository, shared by every clone and the gate's snapshots (the push snapshot carries the
repository's origin URL so it names the repository as the clones do):

| Path                                                                                   | What it is                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<key>/verdicts/<property>/<key hash>.json` | One pass: `<property>` is the SHA-256 of the property id, `<key hash>` that of the key, and the file holds the key itself. A record whose text is not its key is refused and its property runs. `<key>` is the gate's key. |

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

A shell script keeps its number as a `readonly` at its top with the same tags above it: `bin/gate.sh`'s daily check:full
period.

A number the machine reports is read where it is used, never minted, and widths computed from it are no limit:

| Width                                              | Where                                     | What it is                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test processes at once, `testWorkers`              | `packages/testing/src/workers.ts`         | what the machine reports, `availableParallelism()`: one forked test process a logical CPU                                                                                                                                                                         |
| Workers one mutant's trial leases                  | `packages/testing/src/mutate/schedule.ts` | `shareOf`, a plain function of the pool's width (`testWorkers`) and the trials of a run: the width split evenly among them, at least one each, so the trials at once never lease more workers than one test run holds                                             |
| turbo's tasks at once, `"concurrency": "100%"`     | `turbo.json`                              | one task a logical processor; turbo documents `100%` as "all available logical processors" and 10 tasks as its default (https://turborepo.dev/docs/reference/configuration, verified 2026-11-15). JSON carries no comment, so this row is its documentation       |
| One gate run per snapshot                          | `bin/gate.sh`                             | an identity: a snapshot is one directory that a run rewrites; the snapshots of a mode are as many as its runs were ever at once                                                                                                                                   |
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

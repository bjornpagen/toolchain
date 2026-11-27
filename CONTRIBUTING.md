# Contributing to the toolchain

The toolchain is two workspace packages, `@bjornpagen/devtools` and `@bjornpagen/testing`, which every repository
takes as the submodule `vendor/toolchain`. This file says how the checks run, here and in every repository that takes
the toolchain; README.md says what a repository changes to take it.

## When each check runs

| When                       | Command                   | What runs                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After every edit           | `pnpm types`              | `turbo run typecheck`: each package's and the root's typecheck, from scratch: it reads no build info, and turbo replays a package whose inputs did not change at all.                                                                                                                                                                                                                                                  |
| Each landing (`pnpm land`) | `toolchain-land`          | From a jj workspace onto the repository's hub (the remote `hub`), behind the thin gate: `jj fix` with the repository's oxfmt on the files the landing changes, the lockfile against the manifests, the repository's `land:generated` where it has one, `pnpm types`, and the test files the landing adds or changes, by path. A landing whose push the hub refuses because its trunk moved lands again from the fetch. |
| Each batch on the hub      | `pnpm trunk`              | `trunk@<repo>` runs the root's `trunk` script in a worktree of the hub's trunk, then pushes upstream only what passed: `pnpm check`, then, in each package with a `test.config.ts`, `toolchain-test run`: every property whose key holds no cached pass, its search at full width (below).                                                                                                                             |
| On each pin                | `toolchain-test kills`    | The kill census, beside or after the pin's searches: every declared kill of the paths named judged (a cached red answers its kill), each survivor, stale or unjudged kill reported, exit 1 on any. A test got weak; the product is not shown wrong. Never in a run (below).                                                                                                                                            |
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

## A run reads the verdict cache

`toolchain-test run [paths | ids]` (`packages/testing/src/runner/cli.ts`, `runner/affected.ts` runKeyingAt) answers, in
a package root, every property whose verdict key holds a pass from the machine-wide cache, and runs the search of every
other at full width, keeping its verdict under its key: a pass only when its search passed and no worker that ran it had
observed past its key (below), a failure otherwise, which removes the pass its key held. A cached pass is a known answer:
it never runs again while its key stands. So fifteen lanes that run main's full tiers on trees where most properties'
code is main's run only what their trees changed. The report says each property's fate: `<id>: CACHED: …` for each
answered, a verdict line for each run (with what it observed past its key, if it did), and a summary of how many were
cached, run, observed and failed. `affected <ref>` is gone: `run` is the one cached run.

A property's key (`runner/cache.ts` VerdictKey) holds everything its verdict can observe that a digest can state:

| Input                    | How the key holds it                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its identity             | `<module>#<export>[/<member>]`                                                                                                                                                                                                                                                                        |
| Its import closure       | the closure hash (`runner/closure.ts`) of its module joined with the package's `test.config.ts`, its `pg.config.ts` where it has one (the runner loads it by path), and the runner's entry modules, under the config's conditions and this Node's version                                             |
| The toolchain            | the digest of every file of the runner's package (`runner/grounds.ts`), its runner, search and budgets (`runner/limits.ts`) among them, as they stand on disk                                                                                                                                         |
| Node                     | its version, in every closure hash                                                                                                                                                                                                                                                                    |
| Its workers' environment | the digest of every variable a worker is given (`runner/environment.ts`): the toolchain's list (HOME, PATH, the locale, the XDG directories, the account's bus, PGSSLROOTCERT, …), the runner config's `environment`, and the run's CPU allowance. No other variable of the runner's reaches a worker |
| PostgreSQL               | not in the key: a connection to one of the run's own members is a read of its trace, the digest of the installation `pg_config --bindir` lies in, every byte, and of the workbench's `postgres@.service` and the files under the home its lines name, checked whenever the key is read                |
| Its budget and seed      | the budget is the runner's (`runner/limits.ts`, in the toolchain's digest); the rotating stream's seed is derived from the rest of the key, or TEST_SEED's for every property, so a search is a function of its key                                                                                   |

What a property reads at run time is its pass's trace (`runner/traces.ts`): a worker watches every act of a property's
code (`runner/observe.ts`), and each keyable read (a file's bytes, a directory's entries, a path's presence, where a
path resolves to, a link's text, by the property or by a child it starts: a Node child records its own reads in its
own process (`runner/recorder.ts`: the module loader's, node:fs's and its children's), any other child runs under
strace; a connection to one of the run's own cluster members, which reads the PostgreSQL serving it) is kept with the pass, each with the digest of
what it read, checked whenever the key is read: the pass answers while some trace of it reads alike. A read that
changed after the run began keeps no pass. A run keeps its reads once: one reads file holds each distinct read with
its digest and each worker's reads in order, and a pass's trace names it and how far into each of its workers' reads it
goes, so a run's traces cost its distinct reads, and a lookup weighs each read once however many traces hold it. Paths
under the repository are kept from its root, so every checkout of it answers from another's verdicts. What no digest
states is an observation past every key, and its property is never cached: a path's status or watch (a time, an
inode), /proc, /sys or /dev read as a file, a child the guard cannot watch (a shell, exec, fork, one that outlives its
unit, one not Node where strace is missing), what a Node child's recorder cannot see into (a native addon, a glob, a
recursive listing, a directory copied whole, a module loaded before it), a connection to anything but the run's own
members, a thread. The runner's own acts (its watchdog
thread, its reads of /proc, the judge's of a child's tree among them (live.ts processWorkNow), a scratch directory's remover, a pool's workers, a worker's
services built and everything its cluster does: holds, leases, settles, sessions) are no property's; an act outside
any window (a worker's start, its runner config's modules evaluated, work that outlives its window) is the worker's,
its reads in every later trace, an observation making the next window's property unclean. A worker that observed once
is unclean for the rest of its life, and so is every property it runs after, since a module may keep what it read for
another (a memo); for the same reason a trace takes every read of its workers up to its last unit there. A property is
noted by what its own windows did (`<repository key>/<observing | spawning | reading>/<SHA-256 of its id>`): observed;
made keyable reads through a child it started (a compiler's thousands of sources and libraries); or made them in its
own process alone (a fixture, a prelude, the build's catalog). The next run gives each workers of its own kind, so an
observer leaves no reader's worker unclean, a compiler's reads join no mere reader's trace, and no reader's reads join
a clean property's; a note goes once a run of its property does none of them. What every key holds of a database
property, and what is out of every key's reach and so assumed of every property, is stated once, in the guard's doc
(`runner/observe.ts`).

A closure hash (`runner/closure.ts`) is the SHA-256 of everything a module loads as Node loads it: every file reached
through static imports, re-exports and dynamic imports of a literal (never `import type` or `export type`, which Node
erases), resolved by relative path, `imports` and `exports` maps under Node's conditions and the config's, and workspace
packages, each module's links in order with the file each reaches; each external package by its lockfile entry and
those of the packages it depends on, and the file its manifest's exports map gives for the subpath imported; built-ins
by name; Node's version. The conditions count only through what they resolve: two condition sets that resolve every
specifier alike give one closure. Import cycles hash as one unit. A specifier that resolves to nothing, an
undeclared package or a key the lockfile lacks keys nothing, and the run runs every property, saying why.

No run judges a kill (Bjorn, 2026-11-23: the release check is searches only; kill trials run as a census of their own
on each pin). A run answers whether the product is right. Whether each test can still catch the bug it declares is the
kill census's, `toolchain-test kills [paths | ids]` (`packages/testing/src/mutate/commands.ts` killsCommand): every kill
of each property named applied in the checkout and the property's witnesses run under it on workers leased for it, a
kill the cache answers left alone, every judged verdict recorded; one line a property, each survivor, stale or unjudged
kill under it, and the counts; exit 1 on any kill that did not turn its property red. A surviving kill says a test got
weak, never that the product is wrong. `toolchain-test census` reads the same verdicts to say whether each property
ever caught a bug.

Verdicts live per repository, shared by every clone and workspace of it, which name the repository by its origin URL:

| Path                                                                                   | What it is                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<key>/verdicts/<property>/<key hash>.json` | One pass: `<property>` is the SHA-256 of the property id, `<key hash>` that of the key, and the file holds the key itself. A record whose text is not its key is refused and its property runs. `<key>` is the repository's key: the first 12 hex digits of the git hash of its origin URL, with no trailing `/` or `.git`, else of its common git directory. |

Records are content-addressed and immutable: every pass stays under its own key, so lanes that push different trees one
after another find each other's passes, and a failure removes only the pass under its own key. Nothing is collected by
age or by property; a record whose closure no live tree can produce is the only kind a collection may remove. Writes go
to a temporary file beside the record and are renamed into place, so no lock is needed. A record is safe to delete at any
time.

A kill's verdict is a record of the same cache: its key is the property's joint closure joined with the closure of the
file the kill edits, the kill as the one edit it makes (the file, the content hash of its text and of its text with the
kill applied), and the seed policy of witnesses under an edit, which an operator mutant's verdict shares
(`runner/affected.ts` editKeyOf). A kill that turned its property red is a known answer that `kills` and `census` do
not judge again; a changed property, kill, file or module the file loads makes its key new. The file's closure is in
the key whether or not the property's closure holds the file: a check that runs it in a child process or reads it at
run time was keyed by the file's bytes alone, and kept a red that a module the file loads had since taken away
(grizzle, 2026-11-23: 58 of its 1,017 kills' files lay outside their property's closure). An edit whose text loads a
module its file's text does not keys nothing (`runner/cache.ts` editOf), since no closure the key joins holds that
module: it is judged on every run.

The runner that runs is part of every key, so it must be one the repository's closures hold (`runner/affected.ts`
runnerRootsIn): a file of the repository, whose entry modules are roots, or installed in its node_modules, which the
config's closure holds by its lockfile entry. Another checkout's runner run in this one (its binary named by path from
the wrong directory) keys nothing: `run` runs every property and keeps nothing, `verified` refuses, and `kills`,
`mutate` and `census` judge every verdict and record none.

### Properties that need a database

The testing library's database resources (`@bjornpagen/testing/resources`) are proven against a real PostgreSQL:
`packages/testing/test.config.ts`'s layer provides their cluster (`resources.fixtures.ts`), the testing package's own
local cluster (`packages/testing/pg.config.ts`), as units of the workbench's PostgreSQL (`src/pg`). A run's workers
hold it and bring up its member on their first need, and it stops once the run ends; `pnpm pg check` reads what runs as
a run does, and `pnpm pg psql` holds it for its session.

The properties make databases only under the prefix `tc_` (templates `tc_tpl_<digest>`, clones `tc_c_<owner>_<n>`)
and, for the property about collection, a prefix of each case's own (`tcs<hex>_`); each case drops what it made, and
`collect` (`resources/collect.ts`) drops what an ended or killed run left under `tc_`. A run killed in the collection
property can leave `tcs<hex>_` databases, which go by hand (`DROP DATABASE ... WITH (FORCE)`, after `ALTER DATABASE ...
IS_TEMPLATE false` for a template).

### A cluster's families

A repository's cluster (its `pg.config.ts`, `localCluster`) is one family of members at each checkout: `<unit>-<key>`,
the key the first 8 hex digits of the SHA-256 of the checkout's real path (`src/pg/family.ts`), its members
`postgres@<unit>-<key>-<i>`. Every run, command and script of a checkout reaches its own family and no other's, so
trunk's worktree and each lane's workspace never share a member and never wait on each other's SSI LWLocks (on
2026-11-22 trunk's 32-worker pg tier and every lane's run shared grizzle's one family: 54 to 75% of its busy backends
waited on them). The checkout is the workspace root of the working directory (the nearest directory above it holding
`pnpm-workspace.yaml`, else the nearest holding `.git`), so every package of one checkout reaches one family and settles
it from anywhere in it; or that of `TOOLCHAIN_PG_CHECKOUT` where a worker runs elsewhere (the mutator's worker trees). A family's size is derived from the width of the run that reaches it: `ceil(testWorkers / workersPerMember)`
members, `workersPerMember` the repository's measured number, and each member is sized for its share of that run's
workers (`CheckoutFamily`'s `width`, below). A repository starts at 1, a server a worker, and
measures from there: on grizzle's laws subset, its families in memory, 1 took 4% less time than 4 over three runs at
once and 16 twice 4's, for 40 to 47% more of the family in memory (grizzle's pg.config.ts, lane RUNPG1, 2026-11-23).
The testing package's own cluster stays `one`: its resource properties read the databases of the one member, and 7 of
their 23 fail with a member a worker.

- A member runs exactly as long as some process that needs it (`src/pg/hold.ts`). It runs under its lease,
  `<member>-lease.service`, a transient unit that runs nothing, PropagatesStopTo= the member and StopWhenUnneeded=,
  and is started and restarted only by a transient oneshot that requires the lease active (Requisite=), which systemd
  refuses where the lease is stopped and which keeps the lease while it runs; the lease depends on the member in no way,
  so a member's restart is one restart, never a stop that takes a member in memory's data. What wants a lease is a hold, `<family>-hold-<random>.scope`, which each process that
  needs the family makes for as long as it needs it (`familyHeld`), its one process a shell reading a pipe only the
  holding process writes, so the hold ends with that process however it ends, a SIGKILL to its unit included. A run's
  worker holds its family from its first need to its end; a member's settle while it settles; `toolchain-pg settle`,
  `psql`, `admin` and `run` while they run. systemd counts the holds: the last one's end stops every lease no hold
  wants, and each lease its member. The workbench's postgres@ unit takes no dependency at run time (systemd's
  set-property refuses BindsTo= on a loaded unit), and starts no member whose lease is not active (beefy da1e9fc), so
  the dependency lives in the lease, nothing starts or stops a member but its lease, and no cleanup stops one; and a hold binds to a
  process, never to the unit it runs in, since a terminal's scope lives for days and a service may run many runs.
  Before leases, a run that ended, failed or was killed left its members running: on 2026-11-24 379 of grizzle's
  members held 88 GB of /dev/shm's 124.
- `toolchain-pg settle` settles the working directory's family's state (its password, hba file and CA, the ports of
  all the members its width gives, and that width, recorded last in `<state>/width`) and its first member, as the unit
  `<family>-settle`, and leaves nothing running. A run's worker brings up the member it reaches on its first need, and
  no other: where the family's state records another width than the run's, or none, it is settled first as the unit
  `<family>-settle`; where the member is absent or not as its width's spec states it is settled as the unit
  `<family>-<i>-settle` (`toolchain-pg settle <i>`), a second asker joining either unit's start, and a settle that fails
  is that worker's failure. So a family runs the members its live runs reached: a run of one worker, one member. A fresh
  member takes a few seconds (initdb, its owner, template and extensions, a restart), and every run makes again the
  members it reaches; a read of a running one starts nothing.
- Every width (CPUs, workers, threads, places, tasks, a member's connections) is a `Width` (`packages/testing/src/workers.ts`),
  a whole number, one at least, minted only by `widthOf`, its one floor: a width of 0 runs nothing, and a run of nothing
  must never pass (edullm's gate, whose nproc/16 came to 0 under CPUAffinity=0-7, ran no test and exited 0). A run
  that executes no test fails: the Vitest reporter fails one that ends with none executed or never ends, and every
  toolchain-test command refuses a load of no property.
- A run's width is its testWorkers (`packages/testing/src/workers.ts`), half its CPU allowance: the CPUs its affinity
  names, never more than the tightest cpu.max quota of any cgroup from its own to the hierarchy's root (`allowanceOf`;
  Node 26.13.1's `availableParallelism()` reads a slice's quota in place of a tighter one of the unit's own: a unit with
  CPUQuota=400% in a slice held to 16 CPUs reads 16). The run's first process reads it once and gives it every process
  it starts (`TOOLCHAIN_CPU_ALLOWANCE`: the pool's workers, a Vitest run's test processes), so a worker forked after its
  slice's quota moved is of the run's width still. A settle unit runs in its cluster's repository's slice, under another
  allowance than its starter's, so it never reads its own: it is given the width of the family it settles
  (`TOOLCHAIN_PG_SETTLE_WIDTH`, settle.ts `settleEnvironment`, beside the checkout) and sizes the family for that. A
  family settled for one width and reached by a run of another is refused by every read of that run until its first need
  settles it at its own; a person's `check`, `psql`, `admin` and `run`, which run no workers, read it at the width its
  state records (`familyAsSettled`; `psql`, `admin` and `run` at their own where it records none), and so does
  collection. Neither variable is a person's option: each is the
  toolchain's plumbing between its own processes, and a process no run started reads its own.
- Over TLS a family's members claim their ports: the lowest from the spec's `from` that no family claims and nothing
  listens at, each claim a file `~/.local/state/toolchain-pg/ports/<port>` naming its family, created with O_EXCL, so two
  families settling at once take different ports. Nothing waits on a claim. A listener outside the claims (a cluster
  made before families at a port of its own, a test's family claiming in homes of its own, a server a person started)
  can still take a claimed port while its member is stopped, so a settle reads the kernel's socket table (`ss -Hltnp`)
  before it starts each member and refuses one whose port anything but the member's own unit holds, naming each
  holder by its unit and pid (settle.ts portFree), where the member's server would fail to bind it, or bind one
  loopback of two.
- Every settle first collects its cluster's families whose checkout is gone: the folder deleted, or a workspace
  forgotten whose folder lingers (its `.git` file names a git directory that `jj workspace forget` or `git worktree
  prune` removed). Their units are stopped, and their data, claims and state removed. It reads only its own cluster's
  families (`<unit>-<8 hex digits>`) and never a cluster made before families. A live checkout's family keeps its state
  between runs; its members stop with their last run.
- A member whose name a pattern of `~/.config/postgres/memory` matches (the workbench's postgres part) is running or
  absent: its data is in `/dev/shm/postgres/<member>`, its data directory a link there, and the workbench's postgres@
  unit removes both as it stops, but not as it restarts (`postgres-cluster --stopped`). A family no process holds runs
  nothing, so its memory is free; the next run's settles make its members again in seconds.
- A throwaway member logs no test's errors: a client backend's ERROR, WARNING and NOTICE go to the test that provoked
  them, and its log is its unit's journal, whose rate limit dropped other units' lines when test servers logged tens of
  thousands of lines a member (settings.ts ofDurability).
- A test of settling or collection runs in homes of its own (`Homes`, a scratch directory), never the account's
  `~/.local/state/toolchain-pg` or another cluster's units. On 2026-11-22 a kill trial of the collection property ran
  against the account's homes and removed den's, five lanes' and trunk's clusters.

### A family's predicate lock room

Every non-concurrent `DROP INDEX` in a member (each index of a `DROP TABLE` or `DROP SCHEMA ... CASCADE` among them)
walks the member's whole predicate lock target table while it holds every SSI LWLock exclusive, whenever any
SERIALIZABLE transaction of the member is open (PostgreSQL 19.0 `predicate.c` `DropAllPredicateLocksFromTable`). The
table holds `max_pred_locks_per_transaction` targets for every backend. At 2048 a backend and grizzle's 1,559 backends
(768 connections, 765 WAL senders) that is 3.19 million targets, 681 MB of shared memory a member, and 5.6 ms of every
SSI LWLock a drop, against 0.3 ms at 100,000 targets. So a cluster sized for workers states its room
(`sizing.predicateLocks`):

- `{ kind: "perBackend" }`: production's 2048 for every backend. This is the costly default for a repository that has
  not measured.
- `{ kind: "perWorker", targets: n }`: `n` targets for each worker a member serves. A member then holds the least
  `max_pred_locks_per_transaction` whose table holds `share x n`, and never fewer than PostgreSQL's 10.

Whatever the room, every member promotes a relation's page and tuple locks to one relation lock past 1023
(`max_pred_locks_per_relation`), production's at 2048. A room too small fails earlier, never later: a transaction
past it fails with "out of shared memory" (53200), which is a finding to measure again.

To measure `n`:

1. Settle a family of the repository's spec, with `predicateLocks` left at `perBackend`, so nothing clips the peak.
2. Run the repository's heaviest SERIALIZABLE tier on it (grizzle's network tier, or its laws), under trunk's seed.
3. While it runs, read each member's SIREAD locks every second as the bootstrap superuser, from a transient timer
   unit: `select count(*), count(distinct (database, relation, page, tuple)) from pg_locks where mode = 'SIReadLock'`.
   One read takes tens of milliseconds at a small table and about half a second at 3 million targets.
4. A member's room is the larger of its peak targets and half its peak locks, since the table holds two locks a target.
   `n` is that room over the workers the member served, at its largest across members.
5. Write `n` as `@limitKind measured` beside the spec (its evidence, the run, the peak, the decision), and run the tier
   on `perWorker` once more. A 53200 says measure again.

`toolchain-test fuzz <fuzztime>` runs each round at reach `rotating`: a property's rotating stream alone, under a fresh
seed, since its kept tokens, floor and steered phase are the same on every seed and every run and push checks them. A
fuzz time in `ms`, `s`, `m` or `h` is of the run's CPU (its own, its workers' and their children's), never of wall time,
so a budget reaches the same cases however loaded the machine is; `x` counts cases.

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

| Width                                              | Where                                     | What it is                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test processes at once, `testWorkers`              | `packages/testing/src/workers.ts`         | what the kernel states of the process (`allowanceOf`): its affinity's CPUs, never more than the tightest cpu.max quota of its cgroup ancestry; one forked test process for every two of them, one at least, the run's first process's allowance given every process it starts |
| Workers one mutant's trial leases                  | `packages/testing/src/mutate/schedule.ts` | `shareOf`, a plain function of the pool's width (`testWorkers`) and the trials of a run: the width split evenly among them, at least one each, so the trials at once never lease more workers than one test run holds                                                         |
| turbo's tasks at once, `"concurrency": "100%"`     | `turbo.json`                              | one task a logical processor; turbo documents `100%` as "all available logical processors" and 10 tasks as its default (https://turborepo.dev/docs/reference/configuration, verified 2026-11-15). JSON carries no comment, so this row is its documentation                   |
| A search's cases at once, a search's `concurrency` | each test's `explore` or `exhaust`        | left out, one at a time (`oneAtATime`), an identity; stated above one, the test's own input, no resource's bound: the engine finds the same cases at any concurrency, and a sense that reads process-wide counters (guided coverage) runs its cases one at a time             |

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

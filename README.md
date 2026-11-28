# toolchain

The dev tools and the testing library that Bjorn's TypeScript repositories share, as one pnpm workspace:

- `@bjornpagen/devtools` (`packages/devtools`): the oxlint preset and plugin (every lint rule, each reading syntax
  alone), the tsconfig bases, the fixtures that prove every rule, and the commands `toolchain-land`
  (`pnpm land`), `toolchain-typecheck`, `toolchain-oxlint`, `toolchain-oxlint-root` (the root's lint, over the root tsconfig's
  include), `workspace-gate` (the repository-wide tsconfig, manifest and file-name
  checks) and `superstyle` (a Tailwind app's stylesheet contract). No check builds a TypeScript program but the
  typecheck.
- `@bjornpagen/testing` (`packages/testing`): the choice-stream testing library on Effect and Vitest.

A repository takes the toolchain as the submodule `vendor/toolchain`, pinned at a commit; its pnpm workspace lists
`vendor/toolchain/packages/devtools` and `vendor/toolchain/packages/testing`, so both run from source, and it keeps its own decisions in
`toolchain.config.ts`. How the checks run is in CONTRIBUTING.md.

## Consumer migration: the jsdoc and promise plugins load, and no named rule is silent (2026-11-27)

The preset loaded neither oxlint's jsdoc plugin nor its promise plugin, and oxlint runs a built-in plugin's rules only
where a configuration's `plugins` list it, drops the rest from its resolution and says nothing. So
`jsdoc/check-tag-names` and `promise/prefer-await-to-then`, named in a consumer's configuration, never ran (edullm-bd).
Now the preset's core part loads both:

- **jsdoc**, with `jsdoc/check-tag-names` at error over JSDoc's tags and the ones a limit's evidence is written in
  (preset.ts LIMIT_TAGS: the indefensible-numbers skill's `@limitKind` and every kind's tags, `@formatConstant`, and
  the Effect language service's `@stability`). Its other correctness rules run too: a documented generator states
  `@yields`.
- **promise**, its correctness rules but `promise/valid-params`, which reads Effect's `Effect.catch(self, f)` as
  Promise.catch's. `promise/prefer-await-to-then` runs nowhere: its one remedy is an async function, which the Effect
  language service's asyncFunction refuses.

The workspace gate's core-lint refuses a configuration that turns on a rule oxlint's resolution holds in none of its
scopes, at its top, in an override or in a configuration it extends: a rule of a built-in plugin it does not load.
Before you move `vendor/toolchain` past this section:

1. **Fix what the jsdoc plugin finds**: a tag JSDoc does not define and no limit uses (state it as prose), a line of a
   tag's text that opens with `@`, and a documented generator with no `@yields`. grizzle had five, fixed at f1e2b4bd.
2. **Load every plugin whose rules your configuration names**, or delete the names: `pnpm workspace-gate` lists each
   silent rule.

## Consumer migration: a program is checked by one checker (2026-11-27)

`toolchain-typecheck` handed tsrs a type checker for each thread of its task's share (`--checkers <share>`): 64 for a
package checked alone on cassowary. A checker is no thread. It is a universe of types, and each one builds again every
type its files read across a module boundary that no declaration states. For a level of a schema built by a function and
read as `ReturnType<typeof levelOf>`, that is the whole chain of levels below it. Now tsrs checks a program with one
checker (`--checkers 1`, shared/threads.ts ONE_CHECKER), so each type a program needs is built once. Its Rayon pool is
still the task's share (RAYON_NUM_THREADS), and turbo still runs a repository's projects side by side.

Measured on cassowary at load 300 to 500, each run from scratch, peak memory as systemd reads it (TYPECOST):

| Program                                                    | Before: wall, peak, instantiations | One checker          |
| ---------------------------------------------------------- | ---------------------------------- | -------------------- |
| qti-pie's packages/ledger at 3cbb2396, alone (64 checkers) | 52 s, 15.3 GB, 477 million         | 39 s, 1.5 GB, 45.6 M |
| the same at the PIN 3 draft bc96e57f, grizzle 2dc71d9e     | 29 s, 10.4 GB, 276 million         | 23 s, 1.1 GB, 25.5 M |
| grizzle's `pnpm types` at b77d3e04 (9 tasks, 7 checkers)   | 54 to 63 s, 3.1 GB                 | 97 s, 2.5 GB         |

Each of the ledger's other 63 checkers derived pantry's and the ledger's levels again, about 8 million instantiations
each. A program that is one large project loses wall time with one checker: grizzle's root project, its test tier,
took 75 s where it took 38 s at 7 checkers, with the same CPU (88 s against 91 s for the whole `pnpm types`). Its
parallelism comes from more programs, never from more checkers of one. Before you move `vendor/toolchain` past this
section:

1. **Delete any `--checkers` a script passes to `toolchain-typecheck`**: the wrapper refuses one, since tsrs takes the
   last `--checkers` it is given. Nothing else changes in your code.

## Consumer migration: a run's budget holds two parts no width changes (2026-11-27)

A run's budget was one number over all its CPU. Every worker readies each property it runs, importing its module and
opening its needs, so a run on more workers spent more: a budget measured on one worker was refused on two or three
(metis's syzkaller-world: 90.7 s of its 239 s readying on one worker). Now a run's budget has two parts, and neither
changes with the run's width:

- **`budget: { kind: "cpu", run, import }`** in `defineRunner` (runner/config.ts RunBudget), both required.
  - `run` holds the run's CPU beyond its workers' starts and readyings and its run needs' opens (the report's `run`):
    the parent's, and the cases' with their children's and their backends'.
  - `import` holds the most one worker may spend importing one property's module (each row's `imports`).
  - Each open stays held by its need's budget, at every width, as before. A worker's start is the toolchain's own
    work, held by its own suite.
- `toolchain-test run` fails a run past either part, in a line for each part it went past. An import past its part is
  named by its property.
- **Every report carries the parts**: `run`, `runNeeds` (the parent's CPU in its run needs' opens), `workerStarts`,
  and on each row `imports`, `casesChildrenCpu` and `casesBackends`. `metered` stays the whole run's CPU with its
  backends'.

Before you move `vendor/toolchain` past this section, measure a whole run of each package with a `test.config.ts`, as
below, at any width. State twice the report's `run` as `run`, and twice the largest of its rows' `imports` as `import`.

## Consumer migration: a template and the database it was built in share a per-build key (2026-11-27)

A template was named by its identity and its build's reads, and its build database by its identity alone. So a build
could not know what its template would be named, and a name a consumer derived per template (a role prefix its build
creates roles under) could only come from the identity. Two builds of one identity with changed reads then shared
those names; a library or Node update changes what a child's strace reads. A build dropping the roles a former build
left met a template that still owned them (2BP01), and failed until the identity changed. Now:

- **Every build is given a key**: its gate session's transaction id as 16 hex digits (`pg_current_xact_id`, which
  the cluster never assigns twice). Its build database is `tpb_<16 identity hex><key>` and its template
  `tpl_<16 identity hex><key>`. What the build read stays in the template's comment, which is what its standing
  compares, and a build database a builder left under an earlier key is dropped under the gate.
- **`templateKeyOf(name)`** (`@bjornpagen/testing/resources`) reads the key from a build database's name (a build's
  TemplateDatabase `name`) or a template's (a clone's `template`). It is the same at the build and at every clone, and
  different for every other build of the identity.

To migrate: derive every per-template name from the key, not the identity: `templateKeyOf(target.name)` in a build,
`templateKeyOf(database.template)` at a clone. The key is a counter, so the digits that differ are its last: take a
shorter name from its end (`Str.slice(-12)(key)`). Every template is built once more.

- metis: `templatePrefixOf` in packages/database/integration/template.ts and integration/level-installation.ts.
- grizzle: test/support/substrate/templates.ts `templateDigest`, which names a template's allocations, its owner login
  and their passwords (names.ts `templateNames`), and substrate.ts `formerBuildDropped`, which drops a former build's
  roles under them. Derive them from the key: read it at the build from its build database's name, and at a clone from
  its template's.

## Consumer migration: a run spends at most its CPU budget, as the budget meter reads it (2026-11-27)

A run had no bound. A suite that grew, or a toolchain change that made every clone dearer (WAL_LOG at metis's 248 MB
template: four times the member's CPU at four clones at once), passed every gate while it spent hours more. Now every
runner config states what a run of its package may spend, and the run is read the way the budget meter reads a case:

- **`budget: { kind: "cpu", millis }` is required** in `defineRunner` (runner/config.ts RunBudget). `toolchain-test
  run` fails a run whose `metered` CPU is past it, in one line naming what it spent and the budget.
- **`metered` holds the backends.** It is `total` (the parent, the workers and their reaped children) and `backends`,
  the CPU of the PostgreSQL backends the workers' sessions opened, a database suite's larger half, which no process of
  the run holds. Each is counted by the worker that opened it, off its own /proc stat with each readying and unit and as
  its session ends, before its Terminate (runner/work.ts sessionsSpent): one that came and went between two counts is
  counted whole, a run sharing a member with another counts its own alone, and the cluster's own work (its
  checkpointer, its vacuums) is no run's. A connection your code opens itself counts in none until it says so:
  open it through the runner's sessions (the PgCluster spec's `connect` and `superuser`), or have your driver call
  `sessionOpened(pid)` once it knows its backend's pid (node-postgres's BackendKeyData) and `sessionClosed(pid)` before
  it ends the connection (`@bjornpagen/testing/pg-session`).
- **Every report row carries the meter's readings**: `readyingWork` and `casesWork` beside `readyingCpu`, `casesCpu`
  and `childrenCpu`, `openings`, each opening's own reading, which is what a need's budget bounds, and `backends`. A need's or a
  run's budget evidence is then read straight off a report, with no probe.

Before you move `vendor/toolchain` past this section:

1. **Measure a whole run** of each package with a `test.config.ts`: every property run and none answered from the
   verdict cache (a fresh `XDG_CACHE_HOME`), at your gate's width. Read `report.metered` from the run's JSON, whose path
   the run prints (`~/.cache/toolchain-test/runs/<seed>-<pid>.json`).
2. **State twice it** as the config's budget, a `measured` limit (the indefensible-numbers skill): the report's path as
   its `@evidence`, the run's interval, machine, load and width, and what invalidates it.
3. **A run past its budget is a regression to find**, never a number to raise. A budget moves only with a new
   measurement and its cause named.

## Consumer migration: what a member holds is no key's (2026-11-26)

A child that connects to its member over the socket stats the member's socket directory, its unit's runtime directory
`$XDG_RUNTIME_DIR/postgresql-<member>`, which its server makes again at every start, as every run starts it: the read
was keyed, so the property's pass was never kept (grizzle's exitsOnceItsScopesClose: "not kept, since
/run/user/1000/postgresql-... changed while it ran"). Now every path a member holds, as its cluster's spec declares
them (its socket directory, its owner's password file and, over TLS, its CA: resources/cluster.ts heldPathsOf), is the
substrate's state, which the database the verdict already accounts for covers: a read under one, by the property's
process or any child, is neither a keyable read nor an observation (runner/observe.ts guardServers, which takes each
member's addresses and the paths it holds). Nothing to migrate.

## Consumer migration: a worker's cluster registers each member it brings up (2026-11-26)

A backend's lock wait behind an outside holder that works, and its wait on the server's I/O workers, is carried (moves
its case, spends none of its budget) only where its server is registered with the process (runner/backends.ts
registerServerAt). Only the toolchain's own sessions (`pgOwnerSession`, `pgSuperuserSession`) registered their member,
so a repository that passes its own `connect` and `superuser` to `PgCluster.layer` (grizzle) never registered one, and
such waits counted as nothing until a 60 s stall window passed. Now the cluster registers each member when it brings it
up in a worker (pg/session.ts memberRegistered), whatever client reaches it, and the sessions register nothing:
nothing to export, nothing a consumer can forget. Nothing to migrate.

## Consumer migration: a Node child records its own reads (2026-11-26)

The guard keyed a property's verdict by what its child processes read, each read off strace(1)'s trace of the child
(TOOLTRUST2), and strace stops a child at every file call it makes. At load 450 to 550 each stop waits its turn on a
CPU: grizzle's substrate exit child ran 286 to 325 s traced against 65 to 80 s plain (34,872 stops), its property went
from 17.1 s a case to 227.8 s, and its cli property from 230-730 s to over an hour. Now:

- **A Node child records its own reads, at no stop.** A child whose command is the worker's own Node (found on its
  search path as execvp finds it, by its real path) starts as `node --expose-internals --import <the testing library's
  runner/recorder.ts>?to=<a record directory> <its own arguments>`. The recorder runs before any module of the child's
  loads, in every thread and every Node child the child starts, and appends each read once a thread to the record as it
  makes it: the module loader's own (its status probes, package.json reads and walks, legacy main candidates, at the
  loader's one door to the file system, internal/modules/helpers' loaderMethods), node:fs's, its own files made, and
  its children's (a Node child recorded again, any other traced). The guard reads the record once the child exits. A
  property over the library's own programs holds the record to strace's trace of the same child read for read, and a
  budget holds a recorded child to one line a distinct read and at most twice its plain CPU and context switches.
- **Any other child still runs under strace**: git, cat, sh, a compiler's native binary, systemd-run, psql, and a
  Node program started through a shell or a wrapper (`env`, a pnpm `.bin` shim), which strace follows into the Node it
  runs. A Node child's own shell, exec and other programs run under strace inside it.
- **What a recorder cannot see into is an observation**, so its property runs every time: a native addon (its own
  reads), a glob's walk, a recursive listing, a directory copied whole, and a module that loaded before the recorder (a
  child's own `--require` preload). The runtime's own reads (Node's libraries, ICU and OpenSSL configuration, time zone,
  compile cache) are no key's, as they never were of the worker's own: Node's version is in every key.
- A Node child sees `--expose-internals` and the recorder's `--import` in its `process.execArgv` (a fork or worker
  thread inherits them, so it is recorded too), and `module.builtinModules` lists Node's internal modules.

To migrate: nothing, beyond the bump. A child started as `env -u NAME node ...`, through a shell or a `.bin` shim still
runs under strace and stops at every call; start Node itself (`process.execPath`, with `env` in the spawn's options)
to have it recorded. grizzle's test/unit/ir/shape.fixtures.ts starts its child through `env -u NODE_OPTIONS`, which this
machine's Node never reads.

## Consumer migration: a statement's backend is its case's own work (2026-11-26)

A statement was a declared wait whose claim a guard checked: at each reading it asked the member whether the session's
backend still worked, and a wait it found idle twice closed. A backend's CPU was no case's, so a case whose work is
PostgreSQL's was judged by a claim, and a statement sent over a client the toolchain did not wrap was a stall. Now:

- **A case's work is its process tree's and its backends'.** A backend is the tree's when it serves a socket a process
  of the tree holds (/proc/<pid>/fd, the peer read off the kernel's socket tables: `ss -x` for a Unix socket, the
  network's TCP table for a loopback port a postmaster listens on), whatever client opened it, with the parallel
  workers it leads. Its CPU and storage work count as the case's, against its budget, from the reading it was first
  seen at, so a pooled connection's backend counts only what it did for this case.
- **A backend's wait is carried by what its server says carries it**: a lock's holders that work, the checkpointer
  behind a forced checkpoint, the I/O workers. Their CPU moves the case and spends none of its budget; a lock that only
  a session idle in its transaction holds is carried by nothing, so its case is judged a stall. The server is asked
  only where a session of the process registered it (`registerServerAt`), as the toolchain's sessions do.
- `waitingOnWork` (`@bjornpagen/testing/live`) and `backendWorking` (`@bjornpagen/testing/pg-session`) are gone.
  `waitingOn(name)` stays, for a wait on another process's work that no backend of the tree carries: an advisory lock
  another session holds between its statements, a template's build gate.

To migrate: drop every `waitingOnWork(...)` around a repository's own session's `query`; nothing replaces it. A
budget measured on a case's client CPU alone now holds its backends' CPU as well; a case whose budget its SQL work
overruns states the budget its work spends. The machine needs `ss` (iproute2): without it no backend behind a Unix
socket is found, and a long statement over one is judged a stall.

## Consumer migration: a load does each piece of work once, at its run's width (2026-11-26)

grizzle's `pnpm check` waited 1h50m on `toolchain-test load`, for two reasons that multiplied. Its processes ran one at
a time: a load took half its task's share, and a check of 24 tasks at an allowance of 32 leaves a task one CPU. And
each process repeated what is a function of the files alone. It had no compile cache, since the account's switch
reached it, and it was handed no resolution. So each of its 1,135 processes stripped, compiled and resolved its whole
closure again: 2.77 CPU-s a process, where 0.96 is the process's own work. Now:

- **A load's processes start as a pool's workers start** (`childEnvironmentOf`): with the worker environment (a load's
  process inherited the parent's whole environment before), the root's compile cache, and the resolutions the parent
  holds on standard input. A resolutions payload is now a sequence of chunks; a pool's payload is one chunk.
- **A load's process reports, and its parent ends it.** It writes one report on its descriptor 3: its verdict, then
  the chunk of what Node resolved for it. Then it closes the descriptor; it never calls `process.exit`. The parent reads
  the report to its end, ends the process group, and hands every later process each resolution once. The verdict is
  the report, not the exit status. This matters because `process.exit()` can wait forever, joining V8's threads, when a
  background compile is parked waiting for a garbage collection (nodejs/node#54918). One of grizzle's load processes
  sat 20 minutes that way after its module had loaded. So a module that exits as it loads now fails, where its exit
  status 0 passed before. A module that leaves a handle open still loads, and holds nothing.
- **A compile cache the runner names is on whatever the account's switch says.** Node turns the cache off whenever
  `NODE_DISABLE_COMPILE_CACHE` is set, to any value. The switch is the account's, for caches nobody chose a folder for.
  So a child the runner gives a cache directory is started without it, and the runner's own process deletes it before
  enabling its root's directory. The switch is no longer among the worker variables. The account's
  `NODE_COMPILE_CACHE` never reaches a child either: a child's cache directory is always its root's in toolchain-test's
  store.
- **A load runs at half its run's allowance** (`loadWorkers`), not half its task's share. While its sibling tasks run,
  a check holds their shares and the load's processes, one and a half times its allowance at most; once only the load
  runs, half.

To migrate: nothing beyond the bump. On a machine that sets the switch, the worker environment loses a variable, so
every verdict key changes once.

## Consumer migration: a template stands while what its build read stands (2026-11-26)

A database template was named by its identity alone: its declaring module's closure, its name, its content and its
origin. A build that reads a file no module loads (a schema's SQL, a fixture) left its template standing after the file
changed, and a property that cloned a template another worker or run built had none of the build's reads in its trace,
so its cached verdict stood too. Now:

- **A template is named by its identity and its build's reads.** Everything a build reads (a file's bytes, a
  directory's entries, a path's presence, where a path resolves to, a link's text, by its own process or a child it
  starts) is collected apart from its window, kept in the template's comment with the digest of what it read, and
  hashed into its name: `<prefix>tpl_<16 hex digits of the identity><16 of the reads>`. An open takes a built template
  of its identity whose reads all read alike now, and builds a new one when none does. A build one of whose reads
  changed while it ran is built again. Reads of the PostgreSQL serving the member are none of a template's: each opener
  reads its server itself.
- **An open that finds its template standing is given its build's reads** (and its build's first observation past
  every key, if it made one) as its own, so a verdict cached over a template answers only while what the template was
  built from stands, whichever worker or run built it.

To migrate: nothing to change. Every template's name changes once (the identity's text is at version 3), so the first
run after the bump builds its templates again and the next collection drops the old ones. A template whose build reads
a file it writes itself, or one under a directory it made, keeps no read of it: that is the build's own data.

## Consumer migration: a run answers a property that reads at run time while what it read stands (2026-11-26)

`toolchain-test run` answered from the cache only a property that read nothing at run time: one that read a file (a
fixture, a program's prelude, PostgreSQL's catalog), started a child process (tsgo) or connected to its cluster
observed past its key and ran every time (grizzle, 2026-11-25: 1,141 of its 1,316 properties). Now a pass keeps its
trace, and a run answers it while some trace of it reads alike:

- **A trace is every keyable read its workers made at run time**, each with the digest of what it read: a file's
  bytes, a directory's entries, a path's presence, where a path resolves to (realpath), a link's text, by the
  property's process or by a child it starts, which runs under strace; and each connection to one of the run's own
  cluster members, a read of the PostgreSQL serving it (its installation and the workbench's postgres@.service). The
  verdict key's PostgreSQL field is gone: it is a read.
- **What no digest states still observes past every key**, so its property runs every time: a path's status or watch
  (times, an inode), /proc, /sys or /dev read as a file, a child run through a shell, exec or fork or outliving its
  unit, a connection to anything but the run's own members, a thread.
- **A property's workers are of its conduct's kind**: clean, reading (its own process reads), spawning (a child it
  starts reads) or observing, as its last run's windows did (`<cache>/<repository key>/{reading,spawning,observing}/`),
  so a reader's reads join no clean property's trace and an observer leaves no reader's worker unclean.
- A run's reads are kept once, in `<verdicts>/reads/`, each pass's trace beside its record. They accumulate until
  retention by reachability lands.

To migrate: a stall guard that reads a child's /proc itself observes; judge the child's tree by the testing library's
judge (`processWorkNow` over its pid and `overrun`, `@bjornpagen/testing/live`), whose reads of /proc are the runner's
own, no property's (grizzle's type tier). A child's reads are keyed only where `/usr/bin/strace` is installed; elsewhere
a child observes.

## Consumer migration: a closure names what its conditions resolve; a runner keeps its own templates (2026-11-26)

metis rebuilt its database template at every switch between its `react-server` packages and its plain ones (338 s
readying and 63.5 s of migrate CPU a switch): each closure hashed its runner config's condition list, so the two
runners held two closures of one unchanged module, and each claim of a template dropped the checkout's claim of every
other digest of it, so the next collection removed the other runner's template. Two changes fix that:

- **A closure names its conditions only through what they resolve.** A closure hash no longer reads the condition
  list. It reads each module's links in order, each to the file it reaches, and an installed package by its lockfile
  entry plus the file its manifest's exports map gives for the subpath imported under the active conditions. Two runners
  whose conditions resolve every module alike hold one closure, so one template and one verdict key. Two that resolve
  one module otherwise hold two.
- **A template claim names its runner**: the directory of the package whose runner config opened it, relative to the
  checkout's root. Claiming a new digest of a logical template drops only that runner's claim of its old one, so two
  runners of one checkout each keep their own template through alternating runs and collections.

To migrate: run `toolchain-pg settle` after the bump. It makes `toolchain_template_claims_by_runner` and drops the old
`toolchain_template_claims`, and a run refuses a member without the new table, naming settle. Every closure hash
changes once, so every cached verdict and every template is new once: the first run after the bump builds its
templates again, and the next collection drops the old ones.

## Consumer migration: no wall-clock verdicts (2026-11-25)

qti-pie's crust went red with "DeadlineReached ... before any case failed" at 10,485 of 40,960 cases the moment the
machine slowed: its testTimeout of 60_000 gave every search a deadline, so a slower machine failed what a faster one
passed. No verdict rests on the wall clock now, by two constructions:

- **A search has no deadline.** `@bjornpagen/testing/vitest`'s `searched` runs a search under no deadline: it ends by
  its case count under each case's hang guard (caseHang, a bound on the case's own work), and a hang is the gate's
  progress watch to stop. `Deadline`, `noDeadline`, `PRINT_MARGIN_MILLIS`, `DeadlineReached` and a shrink's `deadline`
  end are gone. `defineTestConfig` takes no `timeouts`: every test and hook runs under testTimeout and hookTimeout 0.
- **The gate refuses a timer.** `testing/no-wall-clock-verdict` refuses every finite timeout a test API is given,
  anything but `0`, `Infinity` or `Number.POSITIVE_INFINITY`: a `testTimeout` or `hookTimeout` in a configuration or
  `vi.setConfig`, a test's or a suite's (`it(name, fn, ms)`, `{ timeout }` on it, test or describe, a table's included),
  a hook's (`beforeAll(fn, ms)`), a layer's (`layer(Live, { timeout })`) and a wait's (`vi.waitFor`, `vi.waitUntil`,
  `expect.poll`); and the preset holds every Vite and Vitest configuration file to it
  (`@bjornpagen/testing/scope` VITEST_CONFIGS: `vite.config.ts`, `vitest.config.ts`, `vitest.*.config.ts` and their
  `.mts`, `vitest.workspace.ts`).

To migrate: delete `timeouts` from every `defineTestConfig`, then run `oxlint --fix`, which deletes every finite timer
the rule refuses (a timeout argument with its separator, a `timeout` option or a configuration's timeout with its
separator, and an options object the deletion leaves empty); the constants the timers named are then unused, which
their own lint names. A read of the clock is the author's to replace.

## Consumer migration: one version through every workspace (2026-11-25)

edullm's vendored toolchain stated oxfmt 0.79.0 where edullm stated 0.78.0, and its qti-pie pin's grizzle stated
thirteen entries behind edullm's: each vendored repository proved its code against versions the root never ran it with.
The workspace gate's `catalog-agreement` refuses it, and no exception excuses it. Beside the root's pnpm workspace, every
other one in the tree at any depth (a git-tracked one of the repository's own, a submodule's, a submodule's submodule's)
states each entry it shares with the root's:

- at the root's versions (`version`), read as pnpm resolves them: the catalog's and the named catalogs', or an
  override's alone where one names the entry, an override of `catalog:` that catalog's version;
- with the root's release-age exclusions of it as written, and no other (`exclusion`): `effect` and `@effect/*` in
  every workspace that shares effect, or in none;
- and a versioned exclusion of a shared entry (`name@1.2.3`, `name@1.2.3 || 1.2.4`) names only the root's versions,
  wherever it is stated (`excluded version`).

An entry one side alone states is no agreement's to judge. To migrate: make each finding agree, moving the root or
the vendored repository (whose owner bumps its pin): at the trunks' tips on 2026-11-25 edullm moves oxfmt to 0.79.0 and
its qti-pie pin to one whose catalog states the root's @ui-sdk versions and exclusions, and metis deletes or rewrites its
two `@ui-sdk/*@0.1.0-beta.2` exclusions, which name a version its tree does not install. And `core-lint` now judges a
vendored workspace package's configuration too, as it states: it had read the repository's own packages alone.

## Consumer migration: one core lint set, held by the gate (2026-11-25)

qti-pie's package configuration, built on another preset, loaded no dev tools plugin, so none of the core rules ran on
its files, no-variadic-callback among them; a configuration that names the plugin and its rules by hand misses each
rule the toolchain adds after it. Two constructions close the class:

- **The preset is the one core set.** `@bjornpagen/devtools/preset`'s `standard(toolchain).lintConfig(project)` loads
  the dev tools' plugin and holds every core rule (`CORE_RULES`), and loads the testing library's plugin and holds its
  rules wherever the repository installs it: `tests` is `{ library: "installed", clockFree: [...] }`, the clock-free
  files alone, or `{ library: "none" }`. No configuration names a plugin or a plugin's rule list: `jsPlugin`, `rules`,
  `modules`, `everyFile` and `clock` are gone from `tests`, and TEST_RULES, MODULE_RULES, EVERY_FILE_RULES and
  CLOCK_RULES are the preset's to read (`CASE_LISTS` and `PROPERTY_SEARCHES` stay the repository's options).
- **The workspace gate refuses a configuration without it** (`core-lint`): every oxlint configuration the repository
  tracks (`oxlint.config.ts`, `oxlint.<variant>.config.ts`, `.oxlintrc.json`, a package's own among them) must load the
  dev tools' plugin and hold every core rule at error, as `oxlint -c <configuration> --print-config` resolves it, never
  as its text reads. No exception excuses it.

To migrate: write `tests: { library: "installed", clockFree: <the old clock.files> }` and drop the testing imports
the old fields read; build every oxlint configuration of the repository, a package's own included, with the preset's
`lintConfig`, or delete it so the root's holds its files.

## Consumer migration: `run` reads the machine-wide verdict cache (2026-11-24)

About fifteen lanes each ran main's full tiers on trees where most properties' code was main's (load 600 and more in
seven concurrent `pnpm check` runs). `toolchain-test run` now answers every property whose verdict key holds a pass from
the machine-wide cache (`${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<repository key>/verdicts`, shared by every clone
and workspace) and runs only the rest, keeping each verdict it runs; its report says each property's fate (`CACHED`, or
its verdict line) and how many were cached, run, observed and failed. `toolchain-test affected <ref>` is gone.

A key holds what a property can observe: its identity, its import closure (its module's, the runner config's, the
package's pg.config.ts, the runner's entries, under the config's conditions and Node's version), the digest of every
file of the toolchain's testing package, the digest of its workers' environment, and its seeds: each property's
rotating stream is seeded by its key, so a run at an unchanged key draws the cases it drew before (TEST_SEED=<n> seeds
every property with n, and keys n). What a property reads at run time is its pass's trace: a fixture or a program's
prelude, the PostgreSQL build's catalog, where a path resolves to, a link's text, what a child process it starts reads
(tsgo's sources and libraries: each child runs under strace), the PostgreSQL serving a member it connects to; the pass
answers while every read of some trace of it reads alike, in this checkout or another of the repository. What no
digest states (a file's times, /proc, a shell's child, a connection to another server, a thread) is an observation past
every key: its property runs every time, and every property run after it on the same worker is not kept either
(CONTRIBUTING.md, "A run reads the verdict cache"); a property that observed or read in a window of its own runs on
workers of its own kind next time, so the others stay clean. A stall guard over a child a property starts judges the
child's process tree by the library's judge (`processWorkNow` and `overrun`, `@bjornpagen/testing/live`), whose reads of
/proc are no property's: a consumer's own /proc reader is an observation, so its property is never cached.

What every key holds of a database property (its template, the PostgreSQL serving it, the members' settings) and
what is out of every key's reach, and so assumed of every property (the clock, the server's included; untaped
randomness, SQL's random() included; the machine's live state; the cluster's identities and other sessions' activity;
a value left in a module's state; the checkout's absolute path), is stated once, in the guard's doc
(packages/testing/src/runner/observe.ts).

A worker is given only the variables the toolchain names (HOME, USER, LOGNAME, SHELL, PATH, LANG, LC_ALL, TZ, TMPDIR,
the XDG directories, DBUS_SESSION_BUS_ADDRESS, PGSSLROOTCERT, NODE_DISABLE_COMPILE_CACHE) and those its runner config
names, and the key holds their values.

To migrate:

1. **State `environment` in test.config.ts**: `defineRunner({ include, smallStack, conditions, environment: [], layer,
   mutation })`, naming each variable beyond the toolchain's that a property reads (none for most); it is required.
2. **Replace `toolchain-test affected <ref>`** with `toolchain-test run`, wherever a script or a gate ran it.

## Consumer migration: no width is 0, and a run of no test fails (2026-11-24)

edullm's gate unit, pinned by CPUAffinity to 8 CPUs, read nproc 8, so its nproc/16 width came to 0;
VITEST_MAX_WORKERS=0 then started no worker, Vitest ran no test, Node exited 0 as its event loop drained, and the gate
read that as green. Two constructions close the class:

- **Every width is a `Width`** (`@bjornpagen/testing/workers`): a whole number, one at least, minted by `widthOf`, its
  one floor. The allowance, testWorkers, a run's workers, a task's threads, a pool's places, a trial's share, a
  member's connections and turbo's tasks at once are each one, and what takes a width (`placesOf`, `placesShared`, a
  mutant pool's lease) takes the type. A width a repository derives itself (a share of `processors`, a count of
  members) goes through `widthOf`, never a bare `Math.floor` or division.
- **A run that executes no test fails**, whatever its worker setting: `defineTestConfig` refuses a
  `VITEST_MAX_WORKERS` that is no whole number, one at least, as the config loads (Vitest reads it past any config),
  and sets `passWithNoTests: false`; the reporter (`@bjornpagen/testing/vitest/reporter`) fails a run that ended with
  no test case passed or failed (a filter that matches none) and one whose event loop drained before it ended (a
  worker setting of 0). Every toolchain-test command refuses a load of no property (`run`, `verified`, `kills`,
  `census`, `fuzz`).

To migrate: drop any `VITEST_MAX_WORKERS`, `--maxWorkers` or nproc arithmetic from scripts and units (a unit's width is
its CPUAffinity and CPUQuota, which the allowance reads), and pass a width a repository computes through `widthOf`.

## Consumer migration: a member runs only while a process holds its family (2026-11-24)

toolchain-pg started each member as `postgres@<family>-<i>`, a unit of its own, so a run that ended, failed or was
killed left its members running: 379 of grizzle's members sat idle in /dev/shm (88 GB of its 124), a run of another
repository failed "Disk quota exceeded" and grizzle's runs failed at CREATE DATABASE, and metis found its members idle 3
to 40 hours after their runs. A member now runs exactly as long as some process that needs it, by construction
(`pg/hold.ts`):

- **A member runs under its lease**, `<member>-lease.service`, a transient unit that runs nothing: PropagatesStopTo= the
  member and StopWhenUnneeded=, so systemd stops the lease, and the member with it, once no active unit wants it. A
  settle starts and restarts a member only by a transient oneshot that requires the lease active (Requisite=), so
  systemd refuses the start where the lease is stopped and keeps the lease while the start or restart runs.
- **A process that needs a family holds it**: `familyHeld(family)` makes `<family>-hold-<random>.scope`, wanting every
  member's lease, whose one process reads a pipe only the holding process writes, so the hold ends as that process
  ends, however it ends, a SIGKILL to its unit included. A run's worker holds its family from its first need to its
  end, a member's settle while it settles, and `toolchain-pg settle`, `psql`, `admin` and `run` while they run.
  systemd counts the holds: the last one's end stops every member, a member in memory taking its data with it.
- **`memberBroughtUp` takes a `HeldFamily`** (`familyHeld`'s), so no process brings up a member it does not hold;
  `memberRead`, `memberAtPort` and `membersRunning` read what runs and start nothing, as before.
- **`toolchain-pg env` is gone**: the member it printed would stop as it exited. `toolchain-pg run [--] <command>` runs
  the command with the first member's facts in its environment (`TOOLCHAIN_PG_PORT`, `_HOST`, `_SOCKET`, `_OWNER`,
  `_TEMPLATE`, `_CA` over TLS, `_PASSWORD_FILE`), the member held for as long as the command runs. `psql`, `admin` and
  `run` bring the first member up themselves, at the width the family's state records, else their own.
- **`toolchain-pg settle` leaves nothing running**: it settles the family's state and checks its first member, then
  lets go. A run settles what its workers reach on its own; nothing needs a settle before it.

Each run now makes the members it reaches again, from the family's settled state (3 to 4 s a member alone, the members
in parallel), and builds again the templates its cases need on them.

Before you move `vendor/toolchain` past this section, in the same commit:

1. **Replace every `toolchain-pg env`**: `eval "$(toolchain-pg env)"` followed by commands becomes `toolchain-pg run --
   <script>`, the script reading the `TOOLCHAIN_PG_*` variables from its environment.
2. **Hold before you bring up**: a process that is no run's worker and reaches a member (a bench, a script, a command
   line child that no parent lent a member) holds the family for its life and brings the member up:
   `Effect.flatMap(familyHeld(family), (held) => memberBroughtUp(held, 0, unitSettler))` in a scope that lasts as long
   as it needs the member, where it read `memberRead(family, 0)` of a member a settle left running.
3. **Stop expecting members after a run**: a script that read a member a run or a settle left running holds the
   family itself (2).

## Consumer migration: one width, the run's CPU allowance, from the run to its clusters (2026-11-24)

A run's width and its clusters' sizing came from different sources, so they disagreed whenever a run held fewer CPUs
than the machine: testWorkers read `availableParallelism()`, which on Node 26.13.1 reads a slice's quota in place of a
tighter one of the unit's own, and a settle unit, which runs in its cluster's repository's slice, sized each member for
its own allowance. A run under grizzle.slice's 16-CPU quota met members sized for another width
(ConnectionBudgetExhausted, databases that failed to open); a spec settled in metis.slice was refused in grizzle.slice;
a run of 4 workers under `CPUAffinity=0-7` met members settled for 32 (max_connections 211 where it expects 835). Every
width now comes from one source, and no command takes a width:

- **A process's CPU allowance** (`@bjornpagen/testing/workers` `processors`) is what the kernel states of it: its
  affinity's CPUs, never more than the tightest cpu.max quota of any cgroup from its own to the hierarchy's root, one
  at least. testWorkers is half of it, as before. A run's first process reads it once and gives it every process it
  starts (`TOOLCHAIN_CPU_ALLOWANCE`: the pool's workers, a Vitest run's test processes, and what they start in turn), so
  every process of a run is of one width whenever it starts.
- **A family is reached at a width**: `familyOf(cluster, checkout, homes, width)`, a run's width its `testWorkers`.
  Its state records the width it was settled for (`<state>/width`); a read at another width is refused, and a worker's
  first need (`memberBroughtUp(family, index, settler)`) settles the family's state at the run's width, then the member
  it reaches, where it would have been refused for good. A command that runs no workers reads the family at the width
  its state records: `familyAsSettled(cluster, checkout, homes)`, as `toolchain-pg check`, `psql`, `admin` and `env`
  and collection do.
- **A settle unit never reads its own allowance**: it is given the width of the family it settles
  (`TOOLCHAIN_PG_SETTLE_WIDTH`, beside `TOOLCHAIN_PG_CHECKOUT`) and settles at that width. `TOOLCHAIN_PG_SETTLING` is
  gone with the recipes that set it.
- `MemberSettle`, `memberSettled` and `unitSettled` leave `@bjornpagen/testing/pg`: a `Settler` settles a family's
  state and a member, by their units (`unitSettler`) or in the process (`processSettler`).

Before you move `vendor/toolchain` past this section, in the same commit:

1. **Pass the width to `familyOf`**: a process of a run passes `testWorkers` (`@bjornpagen/testing/workers`), which a
   command line child of a case inherits from its run through `TOOLCHAIN_CPU_ALLOWANCE`; a process that is no run's,
   a bench or a person's script, reads `familyAsSettled` instead.
2. **Delete every settle by hand under an affinity or another slice** (`TOOLCHAIN_PG_SETTLING=1 toolchain-pg settle 0`,
   a oneshot unit that settles member 0 under `CPUAffinity` first): a run settles its family at its own width.
3. **Expect each family to settle once**: no state settled before records a width, so each run's first need settles
   its family's state, and each member it reaches restarts once where its width's settings differ (its
   max_connections, its predicate lock room). `toolchain-pg check`, `psql`, `admin` and `env` refuse such a family until
   it is settled; run `toolchain-pg settle` once where they are wanted first.

## Consumer migration: a run is searches only; the kill census is its own command (2026-11-23)

Bjorn, 2026-11-23: the release check is searches only, and kill trials run as a separate census on each pin. A run
answers whether the product is right; a surviving kill says a test got weak, not that the product is wrong, and every
engine change re-judged every kill (a kill's key covers everything its property reaches): on grizzle's release check at
8d95ede9d the kill trials were 30 of the unit tier's 47 minutes and 27 of the database tier's 55. So
`toolchain-test run`, `affected` and the landing's run of the test files it changes judge searches alone, and a pass in
the verdict cache is a property's search passing at its closure. The kill census is `toolchain-test kills [paths |
ids]`: every kill each property named declares, applied in the checkout and its witnesses run under it, the kills whose
red the cache holds at the property's closure answered from it, each judged verdict kept there under its edit (as
`mutate` and `census` keep theirs, and read them); one line a property with its kills killed and each survivor, stale
or unjudged kill under it, then the counts; exit 1 on any kill that did not turn its property red. No command does
both, and none takes an option to. Before you move `vendor/toolchain` past this section:

1. **Run the kill census where a run judged kills.** A script that took a run's exit as "every kill killed" (a release
   check, a whole-tier gate) runs `toolchain-test kills` over the same paths as a step of its own, beside or after the
   run; a database tier's census settles its family first, as its run does. A run's summary line counts search
   failures alone; the census's last line is `<n> kills of <m> properties: <k> killed, <s> survived, <t> stale, <u>
   unjudged, ...`.
2. **A verdict key holds one edit or none** (runner/cache.ts VerdictKey `edit`, the record's `edit`, null for a
   search), where it held a list: a run's key listed every kill's edit, so a stale kill left a property no key and a
   reordered list needed sorting. Every cached verdict is new once, as at any change of the runner. `verified` and
   `affected` no longer count a landing that changes only a file a kill edits as touching the property: the file is no
   part of its search's verdict.

## Consumer migration: a template is kept while a checkout claims it (2026-11-21)

Collection dropped every template its own run's properties did not declare, so a lane and trunk on one cluster, at two
closures, each dropped the other's builds and built them cold again (metis-test-0 held ten digests of one template).
A template is now kept while any checkout that exists claims it.

- A run claims each template it opens, by the real path of the package root it runs from (a lane's workspace, trunk's
  worktree, a worker tree), in the owner database's `toolchain_template_claims`; claiming a new digest of a logical
  template (its name and declaring module) drops that checkout's claim of the old one. Collection drops the claims of
  checkouts that no longer exist, then a template no claim names, no builder holds and no live worker holds in use.
  A parked but kept workspace keeps its claims: one digest per logical template it used.
- Run `toolchain-pg settle` after the bump: settle makes the claims table (no setting changes, no restart), and a run
  refuses a member without it, naming settle. Templates built before the bump carry no claim and are collected once.
- `collect` takes no argument: what a run declares no longer decides what it collects.

## Consumer migration: a statement's wait is checked against its backend (2026-11-21)

A statement the member holds up server-side (behind a lock, the SSI locks under SERIALIZABLE contention, a checkpoint)
spends no CPU of its client, so a case's guard judged live cases hung. A statement is now a declared wait, and its claim
is checked: each guard reading asks the member whether the session's backend is still `active`, and a wait whose backend
is idle at two readings in a row closes, so an answer that never comes is judged hung, naming the statement.

- The toolchain's sessions (`pgOwnerSession`, `pgSuperuserSession`) declare every statement so. `resources/cluster.ts`
  `run` declares none itself: a repository's own `PgSession` (its `connect` or `superuser` built over its own client)
  wraps its `query` in `waitingOnWork(name, backendWorking(member, pid))` (`waitingOnWork` from
  `@bjornpagen/testing/live`, `backendWorking` from `@bjornpagen/testing/pg-session`, which asks the member over its
  socket as the bootstrap superuser), `pid` its backend's, read once at connect (`SELECT pg_catalog.pg_backend_pid()`,
  or node-postgres's BackendKeyData), or in `waitingOn(name)`, a claim no guard checks.
- The repository's own clients that reach PostgreSQL outside a PgSession (an adapter, raw sessions, psql children)
  declare their statements the same way.

## Consumer migration: kept tokens migrate to options (2026-11-21)

Since toolchain 71eb30f a weighted decision (gen.ts `weighted`, `option`, `production`, `oneOf`, `proportional`;
commands.ts's pick of a command and its stop; swarm.ts's gates and choices) records the option it took, where it
recorded a unit of its options' total. A kept token written before it names another case, or none, wherever its weighted
decision took a unit past an option's first: grizzle found 74 of its 164 unit and type tokens stale.

- At the bump past 71eb30f, run `pnpm exec toolchain-test kept migrate` from each package with kept tokens (or
  `kept migrate <paths | property ids>`), then commit the rewritten modules. Each kept token's case runs on its values
  read as they were meant (a weighted decision's unit as the option that owns it, a pick among commands over their
  weights' greatest common divisor, every other value as it is), its new tape is the token as written now, and the new
  token must replay as it says before its literal is rewritten. It prints each token `moved`, `unchanged` or `UNMOVED`
  with why, and exits 1 on any unmoved: a token whose case fails or runs other than exactly its values (one with a
  weighted decision of a single option of weight above one, which recorded a unit then and records nothing now), which
  `toolchain-test keep` keeps again from its value.
- Run it once. A token carries no format, so it reads every token as written before 71eb30f: run again, it would read a
  migrated token's options as units.
- A change to what a token records ships with its migration in the same commit, as this one does (replay.ts).

## Consumer migration: every need states its budget; run needs (2026-11-21)

A need's open was held to one runner-wide bound, `needOpenMillis` (300 s), on both legs of its guard: the CPU it may
spend and the wall time over which that CPU must move. The two are split. The stall window stays the runner's
(`needStallMillis`, its measured record in runner/limits.ts); the CPU is each need's own `budget`, the owner's measured
choice, since only the owner knows what its open does. `Limits.open` and every order's `open` are gone. A property's
needs still open at once on a worker, judged as one group: they may spend their budgets summed, and a need that opens
alone is held to its own. A need that waits on another process's work declares it (`waitingOn` from
`@bjornpagen/testing/live`, as every statement the library sends, a node-postgres session's connect and end, and the
bootstrap superuser's psql do), so the stall window counts none of it. Before you move `vendor/toolchain` past this
section, in the same commit:

1. **Every Need literal** states `budget` (milliseconds of CPU its open may spend) and `runNeeds` (`[]` for a need that
   reads no run need). The number is a measured limit: its JSDoc carries `@limitKind measured` and its seven tags (the
   `indefensible-numbers` skill). A run's CPU report is a record of it: `~/.cache/toolchain-test/runs/<seed>-<pid>.json`
   holds each property's `readyingCpu`, its readyings' CPU summed over every worker that readied it, which bounds any
   one open of its needs from above. A test's own planted need is a test's input and needs no evidence.
2. **Every `Template.database({ ... })`** states `budget`, the CPU its open may spend on a worker, its build or the wait
   on another worker's build included; `Database.fresh` and `oneOf` take it from the template. A
   `DatabaseNeed` literal states `budget` and `runNeeds` as any need does. The budget is no part of a template's
   identity: no template is rebuilt for it.
3. **A resource a run makes once for every worker** (an app's build) is a `RunNeed`: `{ key, budget, value, open }`,
   where `value` is a Schema whose encoding is JSON and `open: (directory) => Effect<A, NeedFailed, Scope |
   NodeServices | ModuleClosure>` gets the directory the run's workers run in (the package's directory, or a worker
   tree's under a mutant) and the package's closures: `ModuleClosure`'s `hashOf(moduleUrl)` is the digest of a
   module's whole import closure, the one the runner keys verdicts by, so an open that makes what a closure determines
   (a compile of a program's sources) records that digest beside what it made and skips its work while the digest
   stands: one make per distinct closure, never one per run (2026-11-25). The runner opens it ONCE, in its own process, before it forks any worker, under its budget and the stall
   window, and sends its encoded value to every worker. A worker need reads it with `Need.overRun(run, { key, budget,
   open: (value) => ... })`, which declares it, so a run opens only the run needs its properties read. No worker builds
   it or waits on another that does: delete the build lock (a property reading a run need runs its mutants from worker
   trees, as one needing `Checkout.dir` does). One that fails to open fails every property that reads it, unopened.

## Consumer migration: no gate, no lock: lanes land on the hub, trunk gates (2026-11-21)

Bjorn, 2026-11-21, after a lane killed a `nohup`'d gate run, its children and its parent, the account's systemd: every
background job on cassowary is a systemd user unit, nothing locks, queues or waits its turn, lanes land on the
repository's hub behind a thin gate, and `trunk@<repo>` alone runs the whole gate and pushes upstream. The toolchain's
gate (`toolchain-gate`, packages/devtools/bin/gate.sh: the commit and push hooks' snapshots, held under flock(2) locks
through `packages/testing/scripts/hold.pl`) has no caller left, since no repository runs git hooks, and is deleted with
its properties; `pnpm land` waited for a machine-wide push lock, and a pre-push check and a hub's pre-receive hook
refused any push to the trunk that held no lock. All of that is gone:

- **`pnpm land` lands on the repository's hub behind the thin gate** (the jj-lanes skill: lanes land on the bare
  repository `~/.local/var/hub/<repo>.git`, the remote `hub`, and `trunk@<repo>` alone gates a batch whole and pushes
  upstream). From a jj workspace whose working copy is empty (`jj commit` first): `jj git fetch --remote hub`, `jj
  rebase -b @ -o <trunk>@hub`, `jj fix` (the account's fixer, the workspace's oxfmt), the thin gate (`pnpm install --frozen-lockfile`,
  the repository's `land:generated` script where it has one, `pnpm types`, and the test files the landing adds or
  changes, by path, in the package whose test.config.ts holds each), `jj bookmark set <trunk> -r @-`, `jj git push
  --remote hub -b <trunk>`, where `<trunk>` is the hub's own `trunk.branch`, with no default. A push refused because the trunk moved meanwhile is landed again from the fetch; nobody
  waits. A commit that conflicts with the trunk is refused before its gate, the conflict left in the workspace. The
  whole gate is never a landing's: `TOOLCHAIN_LAND_AFTER_REBASE` and the landing's push gate are gone.
- **The whole gate is the repository's `trunk` script**, which `trunk@<repo>` runs in a worktree of the hub on a batch
  of landings before it pushes upstream: `pnpm check`, then every test tier in full (each property and its kills,
  reading no cached pass), with `toolchain-pg settle` first where a tier needs the repository's cluster. Running only
  what a batch affects is a lane's measure, never trunk's.

Before you move `vendor/toolchain` past this section, in the same commit:

1. **toolchain.config.ts states no `land`**: delete it, which is now a type error. A landing reads its trunk from the
   hub (`git config trunk.branch` there, which the workbench's trunk part writes from its repos.list: main, and staging
   for edullm, whose main is production), the branch trunk@<repo> gates, and refuses a hub that states none.
2. **Delete every call of `land.sh pre-push`** (a `.lefthook/pre-push` script that ran it before its own gate, as the
   `pnpm land` section below told a hook that is not `toolchain-gate push` to): the mode is gone, and so is the hub's
   `pre-receive` mode. A hub's `hooks/pre-receive` that a landing installed is a copy of the old land.sh: delete it
   there by hand.
3. **Delete the push lock's file** (`~/.cache/toolchain-land/<repository>.lock`, or wherever `lock` named it) and any
   flock(1) taker of it (grizzle's `~/.cache/grizzle-release/pushlock/push.sh`).
4. **The root package.json states `trunk`**, the whole gate: `pnpm check`, then `pnpm exec toolchain-pg settle` in the
   directory that holds pg.config.ts where the repository has one, then its test scripts, every tier in full (grizzle's:
   `pnpm check && pnpm exec toolchain-pg settle && pnpm test && pnpm test:network`). A repository whose generated files
   a lane must keep consistent states `land:generated`, the command that fails when they are not.
5. Every lane's `node_modules/.bin/oxfmt` is the repository's formatter, which `jj fix` (the account's fixer, the
   workbench's jj part) runs from the workspace's root on each file a landing changes (`--stdin-filepath`), keeping what
   `.oxfmtrc.json` ignores as it is.
6. **Retire lefthook and every call of the gate**: no repository runs git hooks any more (jj runs none), and
   lefthook's install writes them into whatever repository installs it, the hub's bare repository among them when
   trunk@<repo> installs in its worktree, where a pre-push hook dies with "this operation must be run in a work tree"
   and fails trunk's push upstream (trunk@den, 2026-11-21). Delete `lefthook install` from the root's `prepare`,
   lefthook from `allowBuilds` and the catalog in pnpm-workspace.yaml and from the root's devDependencies (then `pnpm
   install`), and lefthook.yml and `.lefthook/`, whose jobs ran `vendor/toolchain/packages/devtools/bin/gate.sh`, which
   is gone: what they ran is the landing's thin gate and trunk's `trunk` script now. A script that ran `gate.sh run
   index …` by hand runs its command in the lane, or leaves it to trunk. Remove the hooks lefthook wrote into a hub
   (`~/.local/var/hub/<repo>.git/hooks/pre-commit`, `pre-push`) by hand, and delete `~/.cache/toolchain-gate-units/`,
   `~/.cache/toolchain-snapshots/` and `~/.cache/toolchain-gate/` once no repository pins a toolchain with the gate.

## Consumer migration: a cluster is units of the workbench's PostgreSQL (2026-11-21)

The toolchain no longer makes, starts, stops or leases a server. A cluster's members are the workbench's
`postgres@<unit>-<i>` units (systemd makes each on its first start), and a member's settle is its one writer (it starts
the member's unit and gives it the spec by ALTER SYSTEM, its hba file, owner role, template and extensions, restarting
the unit only when a setting waits for one; it runs as the unit `<member>-settle`, so a member has one settle at a
time). `toolchain-pg settle` settles the family's state and its first member; a run's worker brings up the member it
reaches on its first need (`memberBroughtUp`), and a read (`memberRead`) starts nothing, refusing a member not as its
spec states and naming the command.
Leases, `scripts/hold.pl`, the family queue and its tickets, `RunLease`, the cluster lock, `@bjornpagen/testing/lock`,
`TOOLCHAIN_PG_CLUSTER` and the private families under `~/.local/var/toolchain-pg` are gone. Before you move
`vendor/toolchain` past this section, in the same commit:

1. **pg.config.ts.** `localCluster({ unit, network, owner, template, extensions, ownerParameters, durability, sizing })`:
   `unit` names the members' units (`"grizzle-test"` gives `postgres@grizzle-test-0..`); `network` is
   `{ kind: "socket" }` or `{ kind: "tls", port }` (member i listens at localhost:port+i over the workbench's TLS, the CA
   in `$PGSSLROOTCERT`); `bin`, `port` and `peerLogins` go. A run's cluster sizes `{ kind: "workers", family,
   connections: { kind: "capacity", backendBytes }, replication: { kind: "default" } | { kind: "capacity" },
   sharedBuffers, locks: { kind: "default" } | { kind: "perTransaction", locks } }`: `backendBytes` is one busy backend's
   Pss at your suite's real work (`/proc/self/smaps_rollup`), measured, and a member admits the machine's memory over it
   among the members; `locks` is the most heavyweight locks one transaction takes. There is no count of runs: nothing
   admits or queues a connection.
2. **The runner layer** needs no `RunLease`: `PgCluster.layer({ prefix, cluster, connect, superuser })` requires
   `Platform | WorkerIndex`, worker i on member i mod the members' count. `PgMember` is `{ name, socket, port, owner,
   password, passwordFile, tls }`, `tls` being `{ kind: "socket" }` or `{ kind: "tls", ca, caFile, wrongCa }`. The
   bootstrap superuser is the account (`bootstrapSuperuser()`), over `member.socket`, never `postgres`.
3. **Settle once a spec changes**: `pnpm exec toolchain-pg settle` from the package with pg.config.ts. A script that
   called `clusterUp`, `stopCluster` or `doctor` calls `settled(spec)` or runs `toolchain-pg settle | check | psql |
   admin | env`; no script stops a member: a member runs only while a process holds its family, and the workbench
   starts none unheld (beefy da1e9fc).

## Consumer migration: a typecheck from scratch (2026-11-20)

TypeScript 7.1.0-beta's incremental check, tsgo's and tsrs's alike, passes code a check from scratch refuses. Once
build info holds a file that uses an imported type, the file's next version, whose last use of the type moved into the
inferred type of an export, passes with the import unused (TS6196). The gate's snapshots, which every clone shares,
held build info another tree wrote, so an unused `import type` passed metis's commit and push gates (METIS-BOOT). Now
toolchain-typecheck reads no build info: the shared base sets no `incremental`, and each run hands tsrs a build info
file of its own (`--tsBuildInfoFile` in a temporary directory, after your arguments), so a composite project, which
TypeScript keeps incremental whatever it is told, reads none either. Build mode (`-b`) is refused, since a build reads
build info to skip the projects it judges up to date. The gate's snapshot keeps no ignored file but node_modules,
.turbo and .fallow, so a generated output another tree left (a package's declarations, a framework's route types) is
gone before your check. turbo still replays every package whose inputs did not change. Before you move
`vendor/toolchain` past this section:

1. **Scripts.** A package's and the root's typecheck is `toolchain-typecheck`, or `toolchain-typecheck -p
   tsconfig.json` for a composite project, where it was `toolchain-typecheck -b` (grizzle's packages and root). Delete
   every `typecheck:full` and its turbo.json tasks: the typecheck is its from-scratch form. Drop `-- --incremental
   false` from `check` (and `check:full`), and drop any `--incremental` or `--tsBuildInfoFile` a script passes: the
   wrapper's build info file comes last and wins, and `--incremental false` is refused for a composite project
   (TS6379).
2. **tsconfig.** A repository base of its own drops `"incremental": true` and the `tsBuildInfoFile` the dced96d section
   below told it to set. A composite project keeps its `composite`, `outDir` and `tsBuildInfoFile`.
3. **turbo.json.** A task that generates files declares them as `outputs`, so a cache hit restores them: the gate's
   snapshot no longer keeps what a check of another tree generated.

## Consumer migration: a lease takes the slots that are free (2026-11-20)

A run's lease on a cluster family no longer waits under the cluster's gate. A run that a waiting run ahead of it held
up, though its own slots were free (PERFIO-push held 5491's gate and slot 0 for 17 minutes with 3 slots free, and every
run of one worker queued behind it), now starts at once. A run still holds a slot for each of its workers or none, but
it takes them wherever they are free: each slot on the member where the run holds fewest, then on the one with the most
free slots. So runs of one worker land on members of their own. A worker reaches the member of its slot, not member
i mod K. A run that cannot have its slots waits in the family's queue (`<first member>/lease/gate.lock`, the old gate's
file, so a holder of an older toolchain queues on it too). The queue's holder is handed each slot it waits for when
that slot is let go (`scripts/hold.pl`'s `lease`). A run wider than all the family's slots is refused, where a run
wider than one member's share was. Before you move `vendor/toolchain` past this section:

1. **Nothing in your code**, unless it calls the lease itself. `RunLease.reserve` and `reserved` now answer the
   run's `Placement`, the member index of each worker's slot, where they answered nothing. `PgCluster.memberOf(worker)`
   answers the member of that worker's slot.

## Consumer migration: turbo's tasks keep Node's compile cache on disk (2026-11-21)

`toolchain-turbo` hands every task NODE_COMPILE_CACHE, the toolchain's compile cache under toolchain-test's cache on
disk, shared by every checkout. A tool a task runs that enables Node's compile cache naming no directory (vite's,
rolldown's, jiti's and alchemy's commands) takes it before os.tmpdir(), where it kept a file a module in a tmpfs of
bounded inodes (cassowary's /tmp ran out, 435,000 of its inodes node-compile-cache entries). Before you move
`vendor/toolchain` past this section, add `"NODE_COMPILE_CACHE"` to turbo.json's `globalPassThroughEnv`, which turbo's
strict environment otherwise drops; the workspace gate's turbo-compile-cache refuses a turbo.json without it.

## Consumer migration: each tool of the gate takes its task's share (2026-11-20)

The gate's tools sized their thread pools to the whole machine under a turbo of many tasks (each oxlint task "using 64
threads" under a turbo of 32; one live gate's oxlint at about 5,400% CPU). Now a repository's scripts run turbo through
`toolchain-turbo run …`, which sets TURBO_CONCURRENCY to the tasks the run executes at once, the fewer of turbo's
concurrency and the tasks its dry run plans, and turbo runs at it and passes it to every task; the toolchain's wrappers
hand each tool the machine's logical CPUs over it, one at least (testing's `threadsPerTask`): `toolchain-oxlint` and
`toolchain-oxlint-root` (oxlint's `--threads`), `toolchain-oxfmt` (oxfmt's `--threads`), `toolchain-fallow` (fallow's
`--threads`) and `toolchain-typecheck` (tsrs, which reads no flag and no GOMAXPROCS), each with RAYON_NUM_THREADS too.
So a check of six tasks at `"concurrency": "100%"` hands each tool a sixth of the machine, and one of more tasks than
processors hands each one thread. A task of a turbo run started without it reads turbo's configured concurrency; a tool
run alone takes the machine. Before you move `vendor/toolchain` past this section, in the same commit:

1. **Every script that runs turbo runs `toolchain-turbo run`** (`check`, `check:full`, `types`, `test`, …), with the
   same arguments; the workspace gate's root-tasks reads it as running turbo.
2. **The root's tool scripts run the wrappers:** `format` is `toolchain-oxfmt --check .`, `format:write`
   `toolchain-oxfmt .`, `dead-code` `toolchain-fallow dead-code`, `architecture` `toolchain-fallow architecture`.
3. **Delete every per-script thread flag** (`--threads`, `GOMAXPROCS=`, `RAYON_NUM_THREADS=`): no script narrows a tool,
   and the workspace gate's no-worker-flags still refuses one. turbo.json's `concurrency` stays as it is.

## Consumer migration: a cluster's lock table is sized (2026-11-20)

A cluster's spec states the heavyweight locks its users hold at once, and each member's `max_locks_per_transaction`
is the least that sizes PostgreSQL's shared lock table to hold them (max_locks_per_transaction entries for each of its
backends and prepared transactions: REL_19_0 lock.c NLOCKENTS), never below PostgreSQL's 128, so concurrent installs on
a shared family no longer exhaust it (5447's 53200: one migration's 1,000 locks beside the rest of the table held by
other installs). Before you move `vendor/toolchain` past this section, in the same commit:

1. **A leased cluster's `sizing` states `locks`**, a `Sized` like `replication`: `{ kind: "default" }` (PostgreSQL's
   128, no setting written) for a repository with no evidence, or `{ kind: "perWorker", perWorker, outside }`, the
   most one worker's transactions hold at once (a template install's largest migration file) and those held outside
   any worker, each the repository's number with its evidence beside the spec.
2. **A cluster sized by its sessions states `locks` too**: `{ kind: "default" }`, or `{ kind: "held", locks }`, what
   its known users' transactions hold at most at once, all of them together.
3. A running member sized for more locks than it holds is the doctor's finding (the setting below its size) until
   `toolchain-pg init --adopt` resizes it; a spec of `{ kind: "default" }` changes nothing on a running cluster.

## Consumer migration: `pnpm land` (2026-11-20)

Bjorn, 2026-11-20: "pnpm land is a GREAT idea, must go into all of our codebases immediately", after metis's
3f46d57 ended its stale-refusal loop: a push gate that waited its turn and then found the trunk moved, rebased and
queued again, ran O(N²) gates for N lanes. `toolchain-land` (packages/devtools/bin/land.sh) waits for the machine's push
lock for the repository and, holding it, fetches the trunk, rebases the clone onto it (aborting on a conflict, nothing
pushed) and pushes, so the push gate, the clone's own pre-push hook, runs once, on the commit that lands, and the push
is a fast-forward of a trunk no other landing can move meanwhile. A push to the trunk that is no landing's is refused
by the push gate (`toolchain-gate push` runs `land.sh pre-push` on git's pre-push lines before any check) and, where the
origin is a local hub, by the hub's pre-receive hook, which each landing installs there. Before you move
`vendor/toolchain` past this section, in the same commit:

1. **toolchain.config.ts states `land`** (required): `{ lock: "~/<path>", branch: "<trunk>" }`, the lock file every
   clone of the repository on the machine takes, written from the home directory, and the branch landings push to.
   A lock another tool already takes on the same file (flock(1), grizzle's interim push.sh) keeps it and a landing out
   of each other.
2. **The root package.json's `land` script** is `sh vendor/toolchain/packages/devtools/bin/land.sh`, by path, as the
   hooks run the gate (no bin, so no consumer's install goes stale by it). Delete the repository's own landing script
   (metis's scripts/land.sh and scripts/hub-hooks/pre-receive, grizzle's ~/.cache/grizzle-release/pushlock/push.sh).
3. **Every clone has a pre-push hook,** since a landing refuses a clone without one (its push would go out ungated):
   the root's `prepare` runs `lefthook install`.
4. **A pre-push hook that is not `toolchain-gate push`** runs `sh vendor/toolchain/packages/devtools/bin/land.sh
   pre-push` on git's pre-push lines first (lefthook.yml's `use_stdin: true`), so it refuses a push to the trunk that is
   no landing's (grizzle's `.lefthook/pre-push/gate.sh`, before its `run HEAD pnpm check`).

Lanes land with `pnpm land` from their clone, on the trunk, with a clean tree; `TOOLCHAIN_LAND_AFTER_REBASE`, when set,
is a command run inside the lock after the rebase, whose tracked changes are folded into the last commit. The proof
that a push is a landing's reads /proc (Linux).

## Consumer migration: zod banned, lists only added to (2026-11-20)

Bjorn, 2026-11-20: "zod is banned from this codebase, effect schema only", and "strengthen the linters even harder so
this can never happen again", after a lane lifted alphatest-novus's zod ban for one package's tests with an override
of a narrower `restrictedImports` list, added zod as a devDependency and imported `zod/v3`, which a ban of the path
`zod` never matched. Before you move `vendor/toolchain` past this section:

1. **Zod is the standard's.** The preset's `BANNED_PACKAGES` bans zod in every repository: every block's
   `eslint/no-restricted-imports` holds the pattern `zod`, `zod/**`, whatever lists the repository passes. Delete the
   repository's own zod ban (grizzle's `ZOD` and engineImports' zod entry, den's and the toolchain's `ZOD`,
   superstarter's, edullm's `zod` pattern in importListsOf, alphatest-novus's `ZOD_BAN`).
2. **toolchain.config.ts states `bannedPackages`,** the packages it bans beside the standard's (`[]` for none), each
   `{ name, message }`: banned from every import, by pattern, and from every manifest.
3. **The workspace gate's banned-packages law** refuses a dependency, devDependency, peerDependency or
   optionalDependency of the root's or any workspace package's package.json, a catalog or named catalog entry of
   pnpm-workspace.yaml, and a lockfile importer's direct edge, that installs a banned package, by name or under an
   `npm:` alias. A third party's own edges (the lockfile's packages and snapshots: zod as the AI SDK's or Drizzle's
   peer) are out of its scope. No exception names it. alphatest-novus's catalog entry and devDependency for zod go.
4. **An override names no rule the preset builds from lists.** `eslint/no-restricted-imports`,
   `no-restricted-globals`, `no-restricted-properties` and `import/no-unassigned-import`, under any prefix oxlint
   resolves (none, `eslint/`, `typescript/`, `@typescript-eslint/`), are a type error in an override's rules
   (ActiveRules), and `restrictedImports` and `restrictedProperties` are no longer exported. A block that added lists
   becomes an entry of lintConfig's new `restrictions` (`[]` for none): `{ paths, restrictedImports,
   restrictedGlobals, restrictedProperties }`, its paths repository-relative, a directory written with its trailing
   `/` (`packages/engine/` for `packages/engine/**`), a file without. A restriction only adds: its files keep the shared
   bans, the root lists and the environment and Effect-free bans of their place, and a file several restrictions name
   takes the last one's lists whole (one of empty lists holds its files to the root's alone). A block that turned a
   list off, or narrowed it below the root's, has no spelling now: move what the root bans that some files may use out
   of the root's lists into restrictions over the files that may not (edullm's IMPORT_OWNERS: the root's clerk policy
   becomes a restriction over `./`, its narrower scopes after it), and refactor what needs a relative import
   (edullm's next.config.ts).
5. **The environment bans admit os's `constants`.** The library may import `constants` from `node:os` or `os`, the
   platform's signal, error, priority and dlopen numbers, which read no environment; every other value of the module,
   its default import and its namespace stay banned. A block that lifted the environment bans for it goes with nothing
   in its place (grizzle's over packages/grizzle/src/adapter/live/call-error.ts).

## Consumer migration: the dependency bump of 2026-11-20

The catalog moves to `@effect/tsgo` 0.73.2, `tsrs` 7.1.0-beta.tsrs3 (tsrs's own numbering of its TypeScript 7.1.0-beta
port, which follows 0.25.0-ts7.1.0-beta), `oxlint` 1.94.0, `oxfmt` 0.79.0, `turbo` 2.11.13, `vitest` 5.1.1,
`fallow` 3.44.0, `arkregex` 0.0.15 and pnpm 12.21.0, the machine's. Before you move `vendor/toolchain` past this
section, in the same commit:

1. **Catalog.** Set those versions in `pnpm-workspace.yaml`'s catalog, then `pnpm install` and `pnpm dedupe --check`.
2. **Diagnostics.** @effect/tsgo 0.73.2 ships five new Effect diagnostics, which the shared base lists at `"error"`:
   `flatMapMapToZipWith`, `flatMapProvideServiceToProvideServiceEffect`, `forLoopPushToForEach`,
   `promiseAllInEffect` and `promiseRaceInEffect`. Every tsconfig that restates the `@effect/language-service` plugin
   lists them at `"error"` too, unless the owner rejects one in `toolchain.config.ts`'s `rejected.diagnostics`. The
   workspace gate's diagnostic-roster compares the base with the installed @effect/tsgo, so the pin and the catalog
   move together: the base at this commit under @effect/tsgo 0.69.0 lists five diagnostics it does not ship.

## Consumer migration: a landing carries its verdicts (2026-11-20)

`toolchain-test verified <ref>` refuses a landing that touches a property (a file of its closure, a file one of its
kills edits, or the lockfile its closure reads, changed since `<ref>`: affected.ts touchedBy, which `affected` counts
"changed since" by) whose verdict key holds no pass at the closure it lands; it runs nothing. A repository whose push
gate runs no property (grizzle's, whose database properties run only in the machine's one database job) calls it on the
landed tip against what the remote held before, after the landing ran its affected properties
(`toolchain-test affected <ref>`, a database property in the database job), whose passes every clone of the repository
shares. Nothing changes for a repository that does not call it.

## Consumer migration: the census of caught bugs (2026-11-19)

`toolchain-test census [paths | ids]`, run from a package root, says of each property whether it has caught a bug
(Bjorn, 2026-11-16: "all tests that have never caught a bug need to be hard deleted. no conditions."): `catches` when an
edit of product source turns its witnesses red, one of its kills or an operator mutant at a place its witnesses ran;
`never-caught` when no product kill and no mutant it ran against did; `unjudged` when the census cannot say (red with no
mutant, its coverage lost, a product file it runs where its mutants never reach, a file whose mutants the package
cannot type). Product source is every file the repository itself tracks outside test scope: a kill of support, a harness
or an oracle shows nothing, nor does a kill of a submodule's file, nor a kept case on its own (write the defect it pins
back as a kill). Standard output is a table, a tab-separated row a property; standard error has each property's
standing as it settles and the counts; it exits 1 when any property never caught a bug or cannot be judged. A
property's kills are judged first; only a property no product kill turned red faces mutants, each tried on a worker of
its own until one turns it red that the package types (only a red mutant is typed: a survivor shows nothing either way),
every property still looking sharing the pool's width.
Database properties run the census through the machine's one database job, as any run of them does. A test module
another runner runs (a Vitest file) is judged where it is, never converted first: `--foreign-command '<command>'
--foreign <module>...` runs each module as `<command> <module>` in the package root, a fresh worker tree under a mutant,
its run whole its one witness, red on a non-zero exit (mutate/foreign.ts), facing every place of each product file its
import closure reaches (another runner transforms what it loads, and its workers write no coverage); a census of foreign
modules alone needs no runner config. Before you move
`vendor/toolchain` past this section:

1. **Test scope moved.** `TEST_SCOPE`, `TEST_SUFFIXES` and `isTestScope` are `@bjornpagen/testing/scope`
   (src/scope.ts), the dev tools' `shared/tests.ts` gone; `@bjornpagen/devtools` depends on `@bjornpagen/testing`
   (its devDependency until now), so run `pnpm install`, which moves one line of your lockfile.
2. **The verdict cache keys edits.** A key's kills are `edits`: each the file, the hash of its text and the hash of its
   text edited (runner/cache.ts Edit), a kill's and an operator mutant's alike, so `mutate` keeps every kill it finds
   under the same key a kill trial keeps, and the census reads both. Every cached verdict is new once, as at any change
   of the runner.
3. **A Property carries its kept cases** (`Property.kept`), which the census counts. A harness that builds a Property
   (`new Property({ ... })`) states `kept`.

## Consumer migration: one assertion vocabulary (2026-11-19)

`@bjornpagen/testing/assert` speaks one vocabulary, grizzle's (UNIFY's census, row 12), where it spoke
@effect/vitest/utils's names beside chai's `assert`: `assert.{ok, equal, notEqual, deepEqual, notDeepEqual, match,
doesNotMatch, throws, throwsAny, rejects, fail}`; the matchers (`matchers`, `like`, `matchesObject`, `containsEqual`);
the collections (`contains`, `lacks` over an array or a set, `containsText`, `lacksText`, `unorderedEqual`); the narrowers
that return their value (`defined`, `nonEmpty`, `assertVariant`, `assertNot`) and `deepEquals`; `failureOf`; and
`assertionFailed`, which a repository's own assertions fail through. Every expected value is typed by the actual one
(`NoInfer<T>`) and a reason is a trailing `...why: Why` tuple, never an optional parameter. Before you move
`vendor/toolchain` past this section:

1. **Rename every call.** `deepStrictEqual(a, b)` is `assert.deepEqual(a, b)`, `strictEqual` `assert.equal`,
   `assertTrue(x)` `assert.ok(x)`, `assertFalse(x)` `assert.equal(x, false)`, `assertSome(o, v)`
   `assert.deepEqual(o, Option.some(v))`, `assertNone(o)` `assert.deepEqual(o, Option.none())`, `assertInstanceOf(v, C)`
   `assert.ok(v instanceof C)`, `assertExitSuccess(e, v)` `assert.deepEqual(e, Exit.succeed(v))`, `fail(m)`
   `assert.fail(m)`; chai's `assert.deepStrictEqual` `assert.deepEqual`, `assert.strictEqual` `assert.equal`,
   `assert.isTrue(x)` `assert.ok(x)`, `assert.isFalse(x)` `assert.equal(x, false)`, `assert.isDefined` `defined`,
   `assert.isAtMost(a, b)` `assert.ok(a <= b)` (and isAtLeast, isAbove, isBelow), `assert.lengthOf(x, n)`
   `assert.equal(x.length, n)`, `assert.notMatch` `assert.doesNotMatch`, `assert.include` on a text `containsText` and on
   a list `contains`; `assertSameMembers`, `sameMembers` and `sameDeepMembers` are `unorderedEqual`, which refuses a
   repeated element: a comparison of lists that hold repeats sorts both sides first.
2. **State a comparison's type where its sides differ.** An expected value no longer widens the comparison: a brand
   against its base type, a mutable array against a readonly one, a literal widened to `string` is a type error. Give
   the comparison its type (`assert.deepEqual<ReadonlyArray<string>>(...)`, `assert.deepEqual<typeof expected>(...)`)
   or pin the literal (`Option.some("unopened" as const)`).
3. **grizzle** keeps its own assertions, those that read its types (succeeded, refused, throwsDefect and the rest), in
   test/support/assert.ts, built on `assertionFailed` and `Why`; everything else it imports from the door.

## Consumer migration: a check that every test module loads (2026-11-19)

`toolchain-test load` loads every test module a package's runner config includes, each apart in a process of its own
under the runner's flags, through the runner's own discover, and fails naming each module that throws as it loads (a
const read in its temporal dead zone, an initializer that throws, an export that is no property) with what it threw: a
fault that otherwise fails every full run and `pnpm mutate` before anything runs, which `pnpm check` never met. A
module whose closure (with the config's and the runner's) loaded before is not loaded again: its pass is kept in
toolchain-test's cache (`<repository key>/loads`), keyed by the closure hash `affected` keys verdicts by, so a check
loads only what changed. Before you move `vendor/toolchain` past this section:

1. **Every package with a test.config.ts** gets a `"load": "toolchain-test load"` script, and the root's `pnpm check`
   runs it (a turbo task `load` with `"cache": false`, beside oxlint and format), as the toolchain's own does.
2. **A script of your own that imports every test module** goes (grizzle's scripts/dev/load-modules.ts).

## Consumer migration: one TypeScript process for syntax (2026-11-19)

`@bjornpagen/testing/syntax` is the one door to TypeScript 7's native parser, one compiler process a test process
shares: `syntaxOf(file, text, read)` reads a text's tree, parsed as the file it is named (its extension its kind), and
`syntaxDiagnosticsOf(file, text)` its syntax errors (`{ code, message, pos, end }`, transpileModule's, no program and no
type). Before you move `vendor/toolchain` past this section, delete a need or helper of yours that starts its own
`new API()` from `typescript/sync` to parse or transpile printed source (effect-openapi-cli-generator's
`typescriptApi`), and read it through the door instead.

## Consumer migration: a cluster is leased or sized by its sessions (2026-11-19)

A cluster's `sizing` says who holds its connections, as a union: `leased`, a test cluster a run's workers lease, its
family and every count sized per worker as before; or `sessions`, a cluster nothing leases (a development cluster
`pnpm dev` and its tools reach), one member whose max_connections is the sessions its known users hold at most at once,
the rest at PostgreSQL's defaults. `LocalCluster` is generic over the arm, and `PgCluster.layer` takes a
`LocalCluster<LeasedSizing>`, so handing a runner's layer a cluster sized by its sessions is a type error, never a
lease divided by a demand nobody stated. The family moves into the leased arm, since a cluster with no workers spreads
none. Before you move `vendor/toolchain` past this section:

1. **A test cluster's pg.config.ts.** `family: F, sizing: { connections: { kind: "perWorker", perWorker, outside },
   replication, sharedBuffers }` becomes `sizing: { kind: "leased", family: F, connections: { perWorker, outside },
   replication, sharedBuffers }`: the leased arm's connections are always per worker, so they carry no `kind`;
   `replication` keeps its `{ kind: "default" }` or `{ kind: "perWorker", perWorker, outside }`.
2. **A development cluster** (kept, reached by an application, never by a runner's layer) states
   `sizing: { kind: "sessions", sessions }`, its `sessions` derived from its known users' own numbers, each stated in
   the repository's code beside the user it bounds: the application's pool maximum where the pool is made (never a
   driver's unstated default), plus one each for a doctor and an operator's psql. Then `toolchain-pg init --adopt` sizes
   its member.
3. **Code that read `cluster.family`** reads `cluster.sizing.family` of a leased cluster.

## Consumer migration: a run leases its cluster (2026-11-19)

A run takes its share of a local cluster's capacity before any of its workers opens a connection there, so runs of
several checkouts on one cluster wait in line rather than refuse each other's connections ("too many clients") or
wait on each other's idle holders in a cycle. The first worker whose need reaches the cluster asks the run's parent
(`RunLease`, from `@bjornpagen/testing/property`, which every worker and inline run has), and the parent reserves
once for the whole run: a slot for each of the run's workers among the family's members (where they are free, since
2026-11-20: the section above), each slot one worker's stated connections, out of the capacity the maker read from the
member's server and recorded beside it (`<member>/lease/capacity`). A run that cannot have its whole set waits in the
kernel: the slots and the family's queue are flock(2) locks, so a waiter holds no connection, transaction or snapshot.
A run never narrows to the slots that are free. Before you move `vendor/toolchain` past this section:

1. **pg.config.ts.** `sizing.connections` is `{ kind: "perWorker", perWorker, outside }`, always: a lease divides a
   member's capacity by what a worker holds, so `{ kind: "default" }` is gone for connections. State `perWorker` as what
   one worker holds at most at once on a member (its owner session and one case's sessions) and `outside` as what no
   worker holds, each with its evidence: a measurement of peak backends over a full run, as the testing package's own
   (2 a worker, 3 outside) was measured.
2. **Your own connections.** A need of yours that opens connections on the cluster outside PgCluster's (grizzle's
   substrate) takes the run's lease first: `RunLease.reserve(reservationOf(port, members, demand, workers))`
   (`@bjornpagen/testing/pg`). A process that is a run of its own outside the runner (a Vitest global setup) holds
   `reserved(reservation)` for its life. Delete any lease of your own (grizzle's substrate lease tables, takeLease,
   leaseSlots).
3. **The cluster, once.** `toolchain-pg init --force` (throwaway) or `init --adopt` (kept), so each member's capacity is
   recorded.

## Consumer migration: the owner's parameters (2026-11-19)

A cluster's spec states the server parameters its owner role may set though only a superuser may by default,
`ownerParameters`. The maker grants them (`GRANT SET ON PARAMETER`) when it makes a member and when `init --adopt` takes
one, the doctor checks them, and the manifest records what was granted, so a spec that comes to name others has them
granted, and the ones it dropped revoked, the next time the cluster is brought up under its lock; a running cluster
whose grants agree is taken as it is. The maker granted SET on `deadlock_timeout` to every owner, grizzle's
installation's need, and nothing else, so a repository granted the rest at run time as the bootstrap superuser. Before
you move `vendor/toolchain` past this section:

1. **pg.config.ts.** Add `ownerParameters`: `[]` where no test sets a superuser's parameter; grizzle's
   `["deadlock_timeout", "session_replication_role"]`, and every repository whose tests install grizzle (den's, eocg's)
   at least `["deadlock_timeout"]`.
2. **Run-time grants.** Delete them (grizzle's ensureMemberSetUp's `GRANT SET ON PARAMETER`).
3. **The manifest, once.** A manifest written before this section has no `ownerParameters` and is refused: run
   `toolchain-pg init --force` on a throwaway cluster, and add `"ownerParameters": []` to a kept cluster's
   `cluster.json` (superstarter's development cluster), whose next bring-up grants what its spec names.

## Consumer migration: packs keyed by name (2026-11-19)

`toolchain.config.ts`'s `packs` is a record keyed by pack name, so no pack can be listed twice, where it was a list of
the builders' values that the dev tools refused at load when one came twice. A pack the repository runs is present: the
drizzle, grizzle and properties packs as `true`, the web pack as its options; one it does not run is absent. The
builders `drizzle()`, `grizzle()`, `properties()` and `web(...)` are gone, and a pack name no `Packs` holds is a type
error. Before you move `vendor/toolchain` past this section:

1. **toolchain.config.ts.** `packs: [drizzle(), webPack]` becomes `packs: { drizzle: true, web: webOptions }`,
   `[grizzle(), properties()]` becomes `{ grizzle: true, properties: true }`, and `[]` becomes `{}`; import only
   `toolchain` from `@bjornpagen/devtools/config`.
2. **A web pack's own module** (edullm's and superstarter's `web.ts`) exports the options, not a pack:
   `export default { root: import.meta.dirname, apps: { ... } } satisfies WebOptions`, with
   `import type { WebOptions } from "@bjornpagen/devtools/config"`.

## Consumer migration: one local cluster maker (2026-11-18)

A repository's PostgreSQL test cluster is made by the testing library, one implementation for every repository
(`@bjornpagen/testing/pg`, `packages/testing/src/pg`): `PgCluster.layer` makes and starts it the first time a need
reaches it, under the port's lock (whose wait is declared to the runner's guards), and takes a running one as it is;
`toolchain-pg` runs its life from a shell. One cluster per repository, each on its own port. Every member gets TLS 1.3
(a local CA, the server's certificate it signed and an unrelated CA, each EC P-256, issued again at a start once any
has expired), SCRAM, hostssl-only hba, an owner role with its password in the member's state, a template database
with the repository's extensions, the owner's own database, and the settings every member holds
(`client_connection_check_interval`, `max_pred_locks_per_transaction = 2048`, UTC, and fsync off for a throwaway
cluster); `wal_level` is PostgreSQL's default, `replica`, at which PostgreSQL 19 turns logical decoding on by itself when
a member's first logical slot is made. Its state is `$HOME/.local/var/toolchain-pg/<port>/`, its manifest `cluster.json`
there, its lock `<port>.lock` beside it; `TOOLCHAIN_PG_CLUSTER=<port>` names a private cluster of the same spec. Before you move
`vendor/toolchain` past this section:

1. **The spec.** State the cluster once, as the default export of a `pg.config.ts` in the package that owns it:
   `localCluster({ port, bin, owner, template, extensions, ownerParameters, peerLogins, durability, family, sizing })`. `bin` is
   `{ kind: "directory", directory }` (grizzle's pinned build: `` `${pin.GRIZZLE_PG_PREFIX}/bin` ``) or
   `{ kind: "pg_config" }` (the server the machine installed). `peerLogins` names the roles this user signs in as over
   a member's socket by peer beside the bootstrap superuser (an application's local login, which then needs no
   secret); `durability` is `throwaway` (fsync off; reset and destroy admitted) or `kept` (a person's data: fsync on,
   never reset, destroyed or made again). `family` is `{ kind: "one" }`, or
   `{ kind: "spread", workersPerMember }` for a repository whose measurement shows a member's shared costs grow with
   its workers. Each of `sizing`'s `connections`, `replication` and `sharedBuffers` is PostgreSQL's default
   (`{ kind: "default" }`) or what one worker holds at most and what is held outside any worker, each the repository's
   number with its evidence beside the spec.
2. **The runner layer.** `PgCluster.layer({ prefix, cluster, connect, superuser })`, where it took `members`, `base` and
   `maintenance`: the template is the spec's, the owner's database the owner's own. The layer needs the platform
   (`ChildProcessSpawner`, `FileSystem`), which the runner provides. `connect` opens the owner's session from the
   member's facts: `PgMember` is the library's, `{ name, port, socket, owner, password, passwordFile, ca, caFile,
   wrongCa }`, and no longer augmented. `superuser` opens a session of the member's bootstrap superuser over its socket
   by peer authentication, on which a clone's role settings are made again (a role's setting in a database takes the
   ADMIN option on the role, which the owner may not hold). A repository whose code reaches the cluster over
   node-postgres passes `pgOwnerSession(applicationName)` and `pgSuperuserSession(applicationName)`
   (`@bjornpagen/testing/pg-session`).
3. **The old maker goes.** Delete the repository's cluster scripts (`init.sh`, `ctl.sh`, `doctor.sh`, `pg.sh`, a
   lifecycle module) and its cluster glue; a script that brought the cluster up calls `clusterUp`, `stopCluster`,
   `destroyCluster` or `doctor`, or runs `toolchain-pg start | stop | status | doctor | psql | admin | reset | env |
   destroy | init [--force | --adopt | --adopt-from <data directory>]`; `--adopt-from` takes a cluster an old maker
   made as the first member, its data directory kept where it lies (linked from the member's state), its hba, ident
   and settings made every member's. A shell that read the cluster's port, CA or password from a pin reads
   `toolchain-pg env` (`TOOLCHAIN_PG_PORT`, `TOOLCHAIN_PG_SOCKET`, `TOOLCHAIN_PG_OWNER`, `TOOLCHAIN_PG_TEMPLATE`,
   `TOOLCHAIN_PG_CA`, `TOOLCHAIN_PG_PASSWORD_FILE`).

## Consumer migration: one typecheck script (2026-11-18)

A package states its typecheck once: `"typecheck": "toolchain-typecheck"`. The from-scratch run, which reads no build
info, is the same task with `--incremental false` passed through turbo (`turbo run typecheck -- --incremental false`),
which turbo hashes apart, so it never replays an incremental pass, and passes to the named tasks alone, never their
dependencies. There is no `typecheck:full` script to forget: edullm's qti-pie had none, so `pnpm check:full` never
checked qti-pie's four packages. Before you move `vendor/toolchain` past this section:

1. **Scripts.** Delete every package's and the root's `typecheck:full`. A script that runs more than one program
   passes its arguments to each (`sh -c 'toolchain-typecheck -p a/tsconfig.json "$@" & toolchain-typecheck "$@"; …'
   typecheck`).
2. **turbo.json.** Delete the `typecheck:full` and `//#typecheck:full` tasks, and any package turbo.json's.
3. **The from-scratch run.** Where `check` (or `check:full`) ran `typecheck:full`, it runs
   `turbo run typecheck … -- --incremental false` in a turbo run of its own, since the arguments go to every task a
   run names. A composite project that emits declarations cannot turn incremental off; its repository keeps a script
   of its own for that (grizzle's `rm -rf types && toolchain-typecheck -p tsconfig.json`).

Nothing else changes: the shared base is incremental as before (until 2026-11-20: "a typecheck from scratch", above),
and the push gate's daily `check:full` still runs where a repository has one.

## Consumer migration: type-aware lint on tsrs (2026-11-18)

oxlint's type-aware rules run in `tsrs --lint`, the TypeScript the typecheck runs (tsrs 0.25.0, TypeScript
7.1.0-beta), and no longer in tsgolint, whose checker is typescript-go 7.0.2's: on edullm's grizzle and pantry types it
took 984 to 1,537 s a package where tsrs takes 8 to 12 s, with the same diagnostics. oxlint 1.93.0 takes the tsrs
package's `tsrs-lint` from `node_modules/.bin` ahead of any tsgolint. Before you move `vendor/toolchain` past this
section:

1. **Catalog.** Add `tsrs: 0.25.0-ts7.1.0-beta` to `pnpm-workspace.yaml`'s catalog and delete `oxlint-tsgolint`.
2. **Manifests.** In the root `package.json`'s devDependencies, and in any other package that names oxlint-tsgolint
   for a type-aware oxlint of its own (edullm's qti-pie), replace `"oxlint-tsgolint": "catalog:"` with
   `"tsrs": "catalog:"`. The root's puts `tsrs-lint` in the root's `node_modules/.bin`, where every package's oxlint
   finds it, under any `nodeLinker`.
3. **Lockfile.** pnpm keeps oxlint's optional peer while the lockfile resolves it: after `pnpm install`, if
   `pnpm-lock.yaml` still names `oxlint-tsgolint` anywhere but oxlint's `peerDependencies`, delete those entries (the
   `oxlint-tsgolint@…` and `@oxlint-tsgolint/…` packages and snapshots, the `(oxlint-tsgolint@…)` suffix of every
   `oxlint@…`, and oxlint's `oxlint-tsgolint` optional dependency) and run `pnpm install` again, then
   `pnpm dedupe --check`. `node_modules/.bin` then holds `tsrs-lint` and no `tsgolint`.

Nothing else changes: `toolchain-oxlint` is still `exec oxlint "$@"`, and every rule, option and file it lints is as
before. `effect-tsgo --tsrs-lint oxlint` is not the way in: it swaps in its own Oxlint binding through a
`NODE_OPTIONS` preload, which a Node built `--without-node-options` ignores (cassowary's is), so there it runs stock
oxlint with whatever type-aware linter that finds, tsgolint while one is installed.

## Consumer migration: a library theme is a stylesheet role (2026-11-18)

Each app's `stylesheet` options in web.ts take `libraryThemes`: the sheets in one directory of the app that draw one
library's markup, which the app renders and does not write, so no utility reaches it (edullm's qti-app draws plate's
questions this way). Before you move `vendor/toolchain` past this section:

1. **No library theme** (superstarter, edullm's nextjs-app): state `libraryThemes: []` in each app's `stylesheet`.
2. **A library theme**: state `{ directory, entry, layer, anchor: { attribute, prefix }, tokens }`, the directory
   repository-relative and ending in `/`, and list its entry in `layeredImports` as
   `{ module: <the entry's path from the app's stylesheet>, layer }`; `superstyle` refuses to run when that import is
   missing. The app's stylesheet imports the entry once, as `@import "<module>" layer(<layer>)`; the entry holds only
   `@import "./<part>.css";` lines, one for each other sheet in the directory; every part holds only
   `@layer <layer> { … }` blocks, whose every selector styles an element carrying the anchor
   (`[data-slot="plate-…"]`, `[data-slot^="plate-"]`) or one inside it, and whose custom properties start with one of
   `tokens`, which no other sheet may declare. `LibraryTheme` in `packages/devtools/src/style/options.ts` has the
   whole contract.

## Consumer migration: a runner config's mutation is loaded by mutate alone (2026-11-17)

`defineRunner`'s `families` is gone: a runner config states `mutation`, a load that only `toolchain-test mutate` calls,
so the launcher, a run's parent and every worker, which import `test.config.ts`, never import what a repository's
operator families read (grizzle's import `typescript/ast`, about 30 ms of CPU in every process). What it loads is a
`Mutation` (`@bjornpagen/testing/runner`): the repository's operator families and the mutants it judged equivalent.
Before you move `vendor/toolchain` past this section:

1. **No families of your own** (den, eocg, superstarter, edullm, the toolchain's own packages): in each
   `test.config.ts`, replace `families: []` with `mutation: noMutation`, imported from `@bjornpagen/testing/runner`
   beside `defineRunner`.
2. **Families of your own** (grizzle): move them into a module that exports `families` and `equivalent`, and state
   `mutation: () => import("<that module>")`, which `no-dynamic-imports` takes on its allowed list
   (`{ file: "test.config.ts", specifier: "<that module>" }` in `oxlint.config.ts`): the runner requires the dynamic
   import. A module whose top level throws refuses mutate, never a run.
3. **Equivalent mutants.** `equivalent` lists `{ file, mutant, why }` (mutants.ts `Equivalent`): a mutant a person
   judged unkillable, by its file (its path from the checkout, as mutate names it) and its id, with the argument. mutate
   gives it the verdict `equivalent`, no trial, outside the score and the survivors, and refuses to run while an entry
   names a file the run mutates and an id none of that file's current mutants has (its code moved or changed: judge it
   again or delete it). A repository with none states `equivalent: []`.
4. **Reading a run.** mutate's summary counts the equivalent mutants, and a second line counts the mutants of each
   operator the run chose, so a family operator aimed at code that moved reads 0.

## Consumer migration: limits retired (2026-11-16)

The limits packages, `@bjornpagen/limit`, the `limits()` pack and its two rules (`no-bare-limit`, `limits-sole-mint`)
are gone (Bjorn, 2026-11-16: "hard retire and totally delete the limit package from every project, and codemod inline
them all back into jsdoc"). Every limit is a plain constant in the module that uses it, its evidence in its JSDoc
(`@limitKind` and the kind's tags), as the `indefensible-numbers` skill says. Before you move `vendor/toolchain` past
this section:

1. **Your limits package.** Turn every mint back into a constant next to its readers and delete the package (the retire
   codemod did this for every repository on 2026-11-16: a limit with one reader goes to that module; with several in a
   package, to the one that reads it most; across packages, to the lowest package the others depend on).
2. **Workspace.** Drop `vendor/toolchain/packages/limit` and `vendor/toolchain/packages/limits` from
   `pnpm-workspace.yaml`, and `@bjornpagen/limit` from every package.json; run `pnpm install`.
3. **Rules.** Drop `limits()` from `toolchain.config.ts`'s `packs`, and `no-bare-limit`, `limits-sole-mint` and
   `LIMIT_TESTS` from `oxlint.config.ts`.
4. **Non-TypeScript readers.** A script that read a generated limits file holds its literal with the evidence above it.
5. **Skill.** Replace `.agents/skills/limits` with
   `ln -s ../../vendor/toolchain/packages/devtools/skills/indefensible-numbers .agents/skills/indefensible-numbers`.
6. **testing.** The testing library takes plain numbers where it took a `Limit` (a property's `caseDeadline`, among
   them): pass the constant.

## Consumer migration: the test system's lints and gates (2026-11-16)

The lints and workspace gates of the test system (TESTSYS): a test module is data, a case's parallelism is the
runner's, and plants are gone. What holds today is on for every repository; what holds only once a repository's tests
are properties is the properties pack, which that repository's conversion turns on.

- Test scope: the testing plugin's rules (`TEST_RULES`) hold every module of test scope, not test modules alone:
  `*.test.ts(x)`, `*.fixtures.ts`, and every module beneath a `test/`, `integration/` or `support/` directory
  (`TEST_SCOPE` in `@bjornpagen/testing/scope`, the one definition the preset and the census read). A support module
  whose job is the clock or a wait is an override's exception, with its reason.
- `TEST_RULES` gains `testing/no-verdict-table` (a list literal of rows writing a verdict under `expected`, `verdict`,
  `outcome` or `answer`, or of tuples whose declared type labels one; a dictionary door's lists pass) and
  `testing/no-restated-concurrency` (`concurrency: 1` in any options object; `oxlint --fix` deletes it with its comma).
- `tests` (the installed library) takes `modules: MODULE_RULES`, the test module's own shape
  (`testing/test-module-shape`: imports, type declarations and `export const x = <call>` alone, no Vitest import),
  which the preset applies to test modules only under the properties pack.
- `devtools/no-case-list` is the core's: every repository states `"no-case-list": { searches, generators, mints,
  cases, dictionaries }`. A search says where it holds its space: `space: { argument: 0 }` (the constructors take it
  first: `property.explore(space, spec)`, `exhaust`, `batched`, `interleave`; `stateful` takes a machine, whose
  reactive mix is typed a `Space`, which no case list is) or
  `space: { field: "draw" }` (the old `explore`'s spec field). Spread `CASE_LISTS` (`@bjornpagen/testing/oxlint`: the
  four constructors, the old `explore`/`exhaust`, `element`, `constant`, `int` (`"range"`), `map`, `span`, `aimed`,
  `finite`, the choices, and the `dictionary` mint), and `PROPERTY_SEARCHES(specifier)` for another specifier of the
  property module (the toolchain's own `#property.ts`), and add the repository's own search helpers and generators; `cases` names
  source paths whose lists are cases (test scope needs no entry); `dictionaries` names the dictionary door modules
  of test scope a list may be imported from. It now follows a list imported from a module of test scope, a range of
  one value (`int(n, n)`) and a range over a list's index (`int(0, xs.length - 1)`).
- `devtools/single-permit-owners` (core, test scope): `{ owners: [{ file, reason }] }`, the files whose work must take
  turns (one session's wire); `Semaphore.make(1)`, `Effect.makeSemaphore(1)` and `withPermits(1)` elsewhere in test
  scope are refused.
- `devtools/no-plant` (core, every file): a comment holding the plant tag or a line opening with `Plants` or `Plant:`.
- The workspace gate, for every repository: `no-plants` (a patch under a `plants/` directory, any file under
  `test/plants/`, a `plants` or `plants:*` script; pnpm's `patches/` are no plants), `no-worker-flags`
  (`--maxWorkers`, `--minWorkers`, `--pool*`, `--no-file-parallelism`, `--runInBand`, `--threads` and their kin in a
  package script, lefthook's configuration or a shell script), `dead-paths` (an oxlint override's glob, or a
  `toolchain.config.ts` exception's path, that names no tracked file; the preset's own test globs excepted), and
  `root-tasks` (a root script named as a turbo task every package runs, such as `typecheck` or
  `oxlint`, that turbo.json registers as no `//#<name>` task: turbo never runs the root's script for the generic task,
  so every `turbo run` of it passes over the root's own files; a root script that runs turbo itself is left alone), and
  `root-files` (a TypeScript file under no workspace package that the root tsconfig's `include` names neither by its
  path nor by a directory above it, an `include` entry that is a glob, or a root `oxlint` script that is not
  `toolchain-oxlint-root`, which lints exactly the `include`'s paths: the root's typecheck and its lint read one list).
- The properties pack, `packs: { ..., properties: true }` (`@bjornpagen/devtools/config`), which a repository's conversion
  adds once its test modules are properties: `testing/test-module-shape` on test modules, and the workspace gate's
  `no-vitest-config` (any `vitest.config.*`, `vitest.workspace.*`, or Vite configuration with a test block) and
  `no-test-shards` (`<name>-<digits>.test.ts`). Until the Vitest adapter goes, a package may keep its unconverted
  modules in one `quarantine.vitest.config.ts` at its root, its `include` naming each file as a string literal; the
  gate refuses an entry that is a glob, names no tracked file, or was no entry of the parent commit's list (no legacy
  module of the parent's package, where the parent kept no list), and an override turning `testing/test-module-shape`
  off that names a file no quarantine holds.

## Consumer migration: a regression kept by value (2026-11-19)

A kept case is a replay token, a tape its space draws again, and `toolchain-test keep` finds the tape of a value the
space draws. A regression recorded as a value its space never draws (a hand-built acceptance case, or a sketch from
before the space changed), or one deeper than keep reaches, is kept beside the space instead:

- `recorded(space, values)` (`@bjornpagen/testing/gen`) is `space`, and beside it `values`, each reachable only
  through its token: its first decision, `source.recall(values.length)`, is 0 for every case a search draws,
  enumerates, mutates or shrinks to, and a token's k, from 1 to the count, draws `values[k - 1]`. A recalled decision's
  tape is bounded by the value it took, so a shrink moves it toward 0 and nothing moves it off 0.
- Wrap the property's whole space, inside its aims or its steering (`aimed(recorded(space, values), aims)`,
  `steered((s) => recorded(under(s), values))`), so the recalled decision is the case's first and an unsteered token
  reaches it; every token the property kept before gains a leading `0.`.
- `toolchain-test keep <id> <file>` finds a recorded value's token (`-:k`) as it finds a drawn value's.
- no-case-list reads `recorded` as it reads `aimed`: a case list beside recorded values is still a case list.

## Consumer migration: steering belongs to the generator (2026-11-15)

A property that read `Case.steering` and swapped its case (`c.draw(aimedGen)` while its turn aimed at a pending
situation) ran one case while the search printed, shrank and offered to keep another, the drawn sketch; a kept case
runs unsteered, so the pasted "keep it" literal kept a case that never failed. Steering now reaches the generator
alone, so a case is one value: the one drawn, run, printed, shrunk, kept and replayed.

- `Case<F>` has no `steering`. A `Draw<S, T, F>`'s `generator` is a `Steered<S, F>`, `(steering:
  Option<Pending<F>>) => Gen<S>`, drawn under the case's steering: the requirements pending when its window began, the
  one its turn aims at among them, offered to the floor stream, the steered phase and a fuzz run, and none for the
  rotating stream. A replay draws under its token's steering; a kept case is its sketch and is drawn by nothing.
- `drawn(gen)` and `sketched(gen, resolve)` ignore steering (`Draw<…, never>`, which fits any feature set).
- `aimed(gen, aims)`, `aims` a list of `[situation, generator]`, draws the generator of the situation the case's turn
  aims at (`pending.aimed`), else `gen`: the old table, `Arr.findFirst(aims, ([s]) => pending.aimed(s))` then
  `c.draw(aim)`, moved into the draw. Its feature type is inferred from the situations it names.
- `steered((steering) => gen, resolve)` is the general form: any logic that read `c.steering` (`pending.has`,
  `pending.names`, a filter over candidates) moves into the function, and the sketch it returns holds what it chose,
  never a choice the property re-resolves under steering a kept case lacks.
- `exhaust` steers nothing: every case of its box runs, its property's draws enumerated with it, so a case aimed at a
  requirement is one the box holds already. A property that drew wider while a requirement was pending draws the
  wider space.
- To move a caller: delete each read of `c.steering`; put its aim in the draw with `aimed(gen, aims)`, or with
  `steered` where the aim is more than a table; and take the case the property is handed as the case. A helper that
  composed a draw (`source.draw(draw.generator)`) composes the steered one:
  `steered((steering) => (source) => [source.draw(draw.generator(steering)), …], resolve)`.
- no-case-list: name `aimed` beside `drawn` and `sketched` among `@bjornpagen/testing/explore`'s `"each"`
  generators (its base generator is the space it reads); `steered` takes a function, which the rule cannot read.

## Consumer migration: the check pipeline (2026-11-14)

What a repository changes to take the toolchain from the check-pipeline plan on (Bjorn's plan and decisions of
2026-11-14). Each part names the commits that bring it. Pin `vendor/toolchain` at a commit whose README holds this
whole section, and do every part: the parts are one migration, in the order a repository can typecheck them.

### 1. Dependencies (ad8d0ec, 3a4a777, 175689e)

- The catalog's versions: `@effect/tsgo` 0.69.0 (tsrs 0.25.0) with `typescript` 7.1.0-beta, `oxlint` 1.93.0,
  `tsrs` 0.25.0-ts7.1.0-beta, `turbo` 2.11.11, `vitest` 5.1.0, `oxfmt` 0.78.0, `fallow` 3.43.0 or later,
  `effect`, `@effect/platform-node` and `@effect/vitest` 4.1.4, `tailwindcss` 4.3.5, `vite` 8.3.8, pnpm 12.18.0
  (`@babel/core` and `@tailwindcss/node`, which only the old style linter and React Compiler check loaded, go in part 4).
  A pin newer than the repository's `minimumReleaseAge` allows waits a day.
- Babel 8 carries its own types: drop `@types/babel__core`.
- @effect/tsgo 0.69.0 ships two new Effect diagnostics, `missingConcurrencyOption` and `onExitFailureToOnError`. Every
  tsconfig that restates the `@effect/language-service` plugin lists `onExitFailureToOnError` at `"error"`, as the
  shared base does, unless the owner rejects it in `toolchain.config.ts`'s `rejected.diagnostics` with its reason.
- `missingConcurrencyOption` is gone for every repository (Bjorn, 2026-11-14): no `Effect.forEach` or `Effect.all`
  states a concurrency to please a diagnostic. The shared base lists it at `"off"`, and so does every tsconfig that
  restates the plugin: change `"missingConcurrencyOption": "error"` to `"off"` (the workspace gate's
  rejected-diagnostics names a tsconfig that sets it to error), and reject nothing for it. Delete every
  `{ concurrency: 1 }` added for it, keeping `discard: true` where the options held it (`{ concurrency: 1, discard:
  true }` becomes `{ discard: true }`): one is Effect's default, a sequential run, so nothing runs differently. A
  concurrency wider than one is a limit, and it answers to the indefensible-numbers policy where it is written (a
  published, measured or derived authority in its JSDoc), not to a diagnostic.
- fallow 3.43 reads more: it reports catalog entries no package names with `catalog:`, reads any directory that holds
  its own `pnpm-workspace.yaml` (ignore build output such as `out/**`), and takes a tsconfig plugin's name for a
  package (`@effect/language-service` belongs in `ignoreDependencies`).

### 2. Incremental typecheck (dced96d)

(Undone on 2026-11-20: "a typecheck from scratch", above.)

- A tsconfig that extends `vendor/toolchain/packages/devtools/tsconfig.base.json` is incremental already. A repository
  base of its own sets `"incremental": true` and
  `"tsBuildInfoFile": "${configDir}/node_modules/.cache/typecheck.tsbuildinfo"` and keeps `"noEmit": true`; drop any
  `"incremental": false`. A composite project that emits declarations keeps its own `tsBuildInfoFile`.
- `node_modules/` must be gitignored (it is in every repository).
- Each package's scripts: `"typecheck": "toolchain-typecheck"` and `"oxlint": "toolchain-oxlint"`. Arguments pass
  through (`toolchain-typecheck -b`, `toolchain-typecheck -p tsconfig.json`). (The `typecheck:full` this part first
  named is gone: "one typecheck script", above.)
- The root's scripts: `"types": "turbo run typecheck"` (with the repository's `--filter`s) and `"typecheck":
  "toolchain-typecheck"`; `check` runs the typecheck from scratch, `turbo run typecheck -- --incremental false`.
- turbo.json: `NODE_OPTIONS` moves from `globalEnv` to `globalPassThroughEnv`. Never set `cacheDir`.
- Agents' instructions: run `pnpm types` after an edit, never the root's `pnpm typecheck` (it checks the root's config
  files only); the hooks run the linters; never `--no-verify` in the main tree.

### 3. Hooks (e277d8d, 266897f, 057540d)

- `oxlint.ast.config.ts` at the root, beside `oxlint.config.ts`:

  ```ts
  import { astOnly } from "@bjornpagen/devtools/preset"
  import { defineConfig } from "oxlint"
  import config from "#oxlint.config.ts"

  /** The commit gate's oxlint: the full configuration without its type-aware rules. */
  export default defineConfig(astOnly(config))
  ```

  with `"#oxlint.config.ts": "./oxlint.config.ts"` in the root package.json's `imports`, and the file among fallow's
  `entry` points. A repository with nested oxlint configuration files: `-c` reads none of them, so the commit gate
  lints those directories with the root's AST-only configuration.

- lefthook.yml, which calls lefthook and the gate by path: `pnpm exec` refuses to run anything while another lane's
  manifest change waits for its install, and the gate installs each snapshot's lockfile on its own.

  ```yaml
  lefthook: node_modules/.bin/lefthook
  pre-commit:
    skip:
      - merge
      - rebase
    jobs:
      - name: gate
        run: sh vendor/toolchain/packages/devtools/bin/gate.sh commit
  pre-push:
    jobs:
      - name: gate
        script: gate.sh
        runner: sh
        use_stdin: true
  ```

  with the push gate in `.lefthook/pre-push/gate.sh`, committed executable (`git add --chmod=+x`), since lefthook
  makes a script job's file executable each time it runs it, which leaves a file committed without the bit as a mode
  change in every clone after its first push:

  ```sh
  exec sh vendor/toolchain/packages/devtools/bin/gate.sh push
  ```

  The push gate is a script job because lefthook (2.2.2) skips a pre-push run job whenever `git diff HEAD @{push}`
  names no file, which is a push of a submodule's gitlink alone (every toolchain move), of deletions alone, or of an
  empty commit: each of those went out ungated, the hook printing `gate (skip) no matching push files`. A script job
  runs whatever the push changes. The commit's run job is skipped only for a commit that stages nothing, whose tree is
  its parent's. The commit gate needs the root's `types` script and `oxlint.ast.config.ts`; the push gate runs the
  root's `check`.

- A repository's own index-copy script (grizzle's `scripts/dev/check-commit.sh`, the old `scripts/check-staged.sh`)
  becomes `sh vendor/toolchain/packages/devtools/bin/gate.sh run index pnpm check`: it handles submodules, which `git checkout-index` left
  empty, and shares the working tree's turbo cache. Its old cache directory (`~/.cache/<repo>-check/`) can go.

### 4. Style and the React Compiler (fab3181, 2820eb3, 0540524, 2af41b6)

Neither the style linter nor the React Compiler check opens a TypeScript program any more. Every repository's catalog
takes `eslint-plugin-better-tailwindcss: 4.11.0`, which the dev tools name with `catalog:`, so an install fails without
it, and drops `@tailwindcss/node` and `@babel/core` (and `babel-plugin-react-compiler` where no app builds with the
compiler), which fallow reports once no package names them. For a repository with a web pack (superstarter, edullm):

- web.ts: the web pack takes `root: import.meta.dirname` (web.ts sits at the root; `superstyle` refuses another value),
  and each app `entryPoint`, the stylesheet its components.json names in `tailwind.css`, and `vendored`, the directory
  its `aliases.ui` resolves to ending in `/`, both repository-relative (`"packages/nextjs-app/src/styles/globals.css"`,
  `"packages/nextjs-app/src/ui/"`); `superstyle` holds both to components.json.
- The preset runs on each app's files, its vendored directory aside: `devtools/markup` (with the app's `markup`
  options), `devtools/no-svg-paint`, and eslint-plugin-better-tailwindcss's `no-unknown-classes`,
  `no-conflicting-classes`, `no-duplicate-classes`, `no-concatenated-classes` and `no-restricted-classes` (arbitrary
  values and Tailwind's palette), loaded by absolute path from the dev tools: nothing to install or name in
  oxlint.config.ts. A style exception in web.ts for `markup`, `no-svg-paint`, `no-unresolved-class`,
  `no-conflicting-classes`, `no-dynamic-class`, `no-arbitrary-value` or `no-invalid-color` still works: the preset
  lifts the rule on its files. Exceptions for `class-extraction` and `no-unverifiable-class` go with those rules.
- What a class rule no longer sees: a class reaches it from a className, a `*ClassName` attribute, a class helper (cn,
  clsx, twMerge, cva, tv), a classList call or a variable named `*Class`, `*ClassName` or `*Classes`, no longer through
  a type; a string literal inside a className expression is read as classes, so write `TONES[tone]`, not
  `TONES[on ? "calm" : "loud"]`; `pb-(--x)` and `bg-[var(--x)]` pass whatever `--x` is (a palette variable aside).
  no-svg-paint follows a paint through the file's own variables only.
- `superstyle` checks the stylesheet contract and standalone HTML alone. A repository's own style rules
  (`ownStyleRules`) get `{ read, stylesheet }` (the reader of a file the run knows, as text) and return
  `{ namespaces, stylesheets, findings }`: class rules and the checker are gone, so a rule that reads classes or syntax
  (edullm's book-units, book-caption) becomes a rule of the repository's own oxlint plugin. `RuleOptions` is the
  stylesheet options alone, so an own rule set's fixture `style` drops `markup`.
- The React Compiler: the preset's web part runs oxlint's React Compiler rules, the correctness category's with
  `react/todo`, `react/unsupported-syntax`, `react/syntax` and `react/invariant`. Drop each app's `react-compiler`
  script and turbo task and `react-compiler` from the root's `check`. Each app keeps `babel-plugin-react-compiler`, which
  `next build` loads, and `REACT_COMPILER_OPTIONS` stays at `@bjornpagen/devtools/react-compiler`.

### 5. superlint's retirement (b8b08f3, 6c9424e, 88e839b, d06393c, d252e0a, 7434219, cbc4adc, 603d066, 7d4ce11, 2e5f998)

superlint is gone: its command and bin, its engine (a `tsgo --api` program per package, one of the three to five
programs a check built per package), its fixtures and its tasks. Every rule it ran reads syntax through oxlint,
maps to built-in oxlint rules, runs in the testing library's reporter or the workspace gate, or is deleted. The rules
that moved into oxlint are AST-only, so the commit gate's `oxlint.ast.config.ts` (part 3) runs them too.

#### Where each rule went

| superlint rule (its pack)                                                                                                                                                                                                                                                          | Now                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no-module-state, no-null-undefined-union, no-spread-argument (core)                                                                                                                                                                                                                | `devtools/no-module-state`, `devtools/no-null-undefined-union`, `devtools/no-spread-argument` (option `tuples`), the core, every file                                 |
| unchecked-vocabulary-literal (core)                                                                                                                                                                                                                                                | deleted                                                                                                                                                               |
| effect-free-packages, its per-file import part                                                                                                                                                                                                                                     | `devtools/effect-free-imports`, on the `effectFree` directories                                                                                                       |
| rejected-diagnostics, diagnostic-roster, effect-plugin-block, effect-free-packages (tsconfigs and manifests), ts-only-extensions (root)                                                                                                                                            | the `workspace-gate` command, which reads JSON and git's file list; same rule names, messages and toolchain.config.ts keys                                            |
| no-drizzle-write-without-where (drizzle)                                                                                                                                                                                                                                           | `devtools/no-drizzle-write-without-where` (ported: eslint-plugin-drizzle does not load under oxlint as published), option `receivers`                                 |
| no-implicit-select-all, no-bare-materialized-view-joins, sql-aliased-table-reference, sql-distinct-window, sql-dynamic-schema, sql-executor-contract, sql-json-owner, sql-leaf-owners-only, sql-number-decoder, sql-query-deadline, sql-raw-execution, sql-raw-statement (drizzle) | `devtools/<the same id>`, the drizzle part, every file                                                                                                                |
| sql-cast-owner (drizzle)                                                                                                                                                                                                                                                           | `devtools/no-raw-sql`, now in the core, on Drizzle `sql` templates only: its `writers` are the old cast owners                                                        |
| sql-array-parameter, sql-case-arm-cast (drizzle)                                                                                                                                                                                                                                   | deleted                                                                                                                                                               |
| no-case-list (grizzle)                                                                                                                                                                                                                                                             | `devtools/no-case-list`, the grizzle part, every file                                                                                                                 |
| no-environment (grizzle)                                                                                                                                                                                                                                                           | the preset's environment bans: `environment` in `lintConfig` turns on node/no-process-env and eslint/no-restricted-imports, -properties and -globals over the library |
| test-case-is-search (grizzle)                                                                                                                                                                                                                                                      | the testing library's Vitest reporter, at run time: `examples` in `defineTestConfig`                                                                                  |
| limit-evidence, no-optional-public-input, sql-text-assertion, tuple-identity (grizzle)                                                                                                                                                                                             | deleted; oxc/bad-object-literal-comparison, on through the correctness category, keeps tuple-identity's literal case                                                  |

#### toolchain.config.ts

- Delete `core: { ... }` and `own: [ ... ]`. A key no `Toolchain` holds is now a type error, so `pnpm types` names
  any that is left.
- `grizzle({ ... })` becomes `grizzle()`, and `drizzle({ ... })` becomes `drizzle()`. Their options move to
  oxlint.config.ts or to the Vitest configs, as below; `uncheckedVocabularyLiteral`, `sqlTextAssertion`,
  `limitEvidence`, `testCaseIsSearch`'s `scaffolds` and `noCaseList`'s `files` and `dictionaries` have no successor.
- `exceptions` names the workspace gate's rules alone: `rejected-diagnostics`, `diagnostic-roster`,
  `effect-plugin-block`, `effect-free-packages` and `ts-only-extensions`. Any other rule id is a type error, and the
  workspace gate refuses to read the toolchain. Move each other entry as "Every exemption's new home" says.
- `rejected.rules["eslint/prefer-spread"]`'s reason names the dev tools' no-spread-argument (an oxlint rule), not
  superlint.
- `@bjornpagen/devtools/config` exports `toolchain`, `drizzle`, `grizzle` and `web` (and the types): `ownRules` and
  `OwnRules` are gone.

#### oxlint.config.ts

`lintConfig`'s `Project` and the plugin's options are typed, so tsc lists each field that is missing.

- `environment: { library, readers }`, required. `library`: the directories that read no environment, as `effectFree`
  names them (repository-relative, no trailing "/"); `readers`: the files among them that may, by path. Write
  `{ library: [], readers: [] }` where there is nothing to guard. The library is held to node/no-process-env and to
  restricted imports, properties and globals: `process`'s environment and its default export, `os`, v8's heap
  readings, Effect's `Config` and `ConfigProvider` (type imports allowed), `globalThis.process` and `navigator`, beside
  the repository's own lists; Math.random stays banned where the library is also Effect-free. An imported value is
  refused at its import, and `import.meta.main` is no longer read, so an entry module that reads argv or the working
  directory is listed in `readers`. An override that calls `restrictedImports` or `restrictedProperties` replaces the
  environment lists for its files.
- `plugin`, the shared plugin's names for the parts the repository runs:
  - `"no-spread-argument": { tuples: [{ module, names }] }`, every repository; `{ tuples: [] }` is fine. A spread
    passes when its length is written in source (a spread-free array literal, an `as const` tuple, a binding with a
    written tuple type, the function's own rest parameter, a same-file function with a fixed-tuple return type), or
    when it is the result of an imported function `tuples` names, by import specifier as the code writes it.
  - `"no-raw-sql": { sources, writers }`, every repository, since the rule is in the core now: `sources`, the
    directories whose code writes SQL; `writers`, the files that may write a `::` cast as text (the old
    sqlCastOwner owners). It reads Drizzle `sql` templates only (e56b3f8): a template whose tag the file imports
    from drizzle-orm, by name, renamed or off a namespace import, read as Drizzle sends it, with a `::` inside a
    quoted string or identifier, a comment or a dollar-quoted body passing. A string literal, an untagged template
    and another tag's template are no SQL to it, so a `::` in a regular expression, an ARN or a PL/pgSQL body held
    in a plain template needs no writer or override. A repository whose SQL is no Drizzle template (grizzle's
    printer builds strings) gets nothing from it.
  - grizzle pack (grizzle, den, the toolchain): `"no-case-list": { searches, generators, cases }`. Searches and
    generators are named by the module the code imports them from, not by repository path:
    `searches: [{ module: "@bjornpagen/testing/explore", name: "exhaust", space: "generator" }, { module:
    "@bjornpagen/testing/explore", name: "explore", space: "draw" }]`; `generators`: `@bjornpagen/testing/gen`'s
    `element` draws `"list"`, `constant` `"value"`, `map` and `span` `"each"`, `oneOf`, `weighted` and `proportional`
    `"union"`, and `@bjornpagen/testing/explore`'s `drawn`, `sketched` and `aimed` `"each"`, each as
    `{ module, names, draws }`; `cases`, the old `cases` list (a directory ending in "/", or a file). A list
    imported from another module passes, so `dictionaries` goes; the rule runs on every file, so `files` goes. The
    toolchain's own oxlint.config.ts is a worked example.
  - drizzle pack (superstarter, edullm), each from the old `drizzle({ ... })` option:
    - `"sql-leaf-owners-only": { owners }` from `sqlLeafOwnersOnly`;
    - `"sql-json-owner": { owners }` from `sqlJsonOwner`;
    - `"sql-dynamic-schema": { tableFactories }` from `sqlDynamicSchema`, same shape;
    - `"sql-raw-execution"` from `sqlRawExecution` and `"sql-raw-statement"` from `sqlRawStatement`, same shapes;
    - `"sql-query-deadline"` from `sqlQueryDeadline`, except that an admitted `value: { module, constant }` becomes
      `value: { specifier, constant }`, the specifier the owner imports the constant by; the constant is imported,
      not declared in the owner (edullm: `{ specifier: "#postgres/limits.ts", constant:
      "SILVER_READER_TIMEOUT_MILLISECONDS" }`);
    - new `"no-drizzle-write-without-where": { receivers }`, the names of Drizzle handles the file cannot trace
      (superstarter `["database", "builder", "tx", "db"]`, edullm `["db", "database", "tx"]`);
    - new `"no-bare-materialized-view-joins": { modules: [{ specifiers, views }] }`, the materialized views other
      modules export; `{ modules: [] }` where there are none;
    - no-implicit-select-all, sql-aliased-table-reference, sql-distinct-window, sql-executor-contract and
      sql-number-decoder take no options: the drizzle part turns them on.
- `overrides`: a lint rule's exception is a block, `{ files, rules: active({ "devtools/<rule>": "off" }) }`, with a
  JSDoc reason on the rule, never a toolchain.config.ts entry.

#### Tests: the runtime search check

- Every `defineTestConfig` call takes the new required field `examples`. Where superlint ran test-case-is-search
  (grizzle, den), write `examples: { kind: "banned", exempt: [{ files, reason }] }`; elsewhere (superstarter, edullm
  with qti-pie, effect-openapi-cli-generator) `examples: { kind: "allowed" }`, or `"banned"` to adopt the check.
- `exempt` paths are relative to the Vitest root (the config's directory); one ending in "/" names a directory, any
  other one file. Each group keeps the reason it had in `testCaseIsSearch.exempt`.
- A test counts as a search when it starts `explore`, `exhaust` or `interleave`, through any helper, so tests change
  nothing. A config that names `@bjornpagen/testing/vitest/reporter` itself passes
  `["@bjornpagen/testing/vitest/reporter", { examples }]`; banning examples needs `defineTestConfig`, which installs
  the setup file that counts searches. Passing `--reporter` on the command line replaces the configured reporters and
  so drops the check.
- A search's `concurrency` is optional (Bjorn, 2026-11-15): `explore`'s `Exploration` and `exhaust`'s `Exhaustion`
  run one case, or one sketch, at a time where it is left out, a sequential run, Effect's default. Delete every
  `concurrency: 1` in a search's spec, which only restates it; a spec that still states it typechecks and runs the
  same. State a width above one only where it is the test's own input, as CONTRIBUTING.md's concurrency limits say.

#### package.json, turbo.json, lefthook.yml, tsconfig, fallow

- Every package's package.json: delete the `"superlint"` script, and `"fixtures:superlint"` where a repository proved
  its own superlint rules (edullm).
- The root package.json: delete `"superlint"`; add `"workspace-gate": "workspace-gate"`; in `check`, drop `superlint`
  and `fixtures:superlint` and add `workspace-gate`.
- turbo.json: delete the `superlint`, `//#superlint` and `fixtures:superlint` tasks, and any task input that names
  superlint's files; add `"//#workspace-gate": { "cache": false }` (it reads the whole tree in about a second, which a
  cache would have to hash).
- Run `pnpm install` after the manifests change: the dev tools' bins change, and pnpm's `verifyDepsBeforeRun` refuses
  every script, the hooks' included, until they are relinked.
- lefthook.yml: the gate of part 3, which runs no superlint; delete any comment that still names it (grizzle's
  pre-push comment does).
- tsconfig: nothing changes for superlint itself; drop an `include` or `exclude` that names superlint's fixtures
  (edullm's `packages/platform/lint/src/superlint/fixtures`).
- fallow: drop entry points and ignore patterns that name superlint's files.

#### Imports that go

- `@bjornpagen/devtools/superlint/finding`, `/superlint/paths`, `/superlint/sql`, `/superlint/types`, and `ownRules`
  and `OwnRules` from `/config`. `Finding` stays importable from `@bjornpagen/devtools/style`.
- `@bjornpagen/devtools/native-api` keeps `nativeSession` and `openProject`, for a repository's own tools that parse
  with the native compiler (grizzle's `scripts/dev/shared/native-syntax.ts`); `withProgram` and `RoundTrip` go.
  No toolchain check opens a session.
- `@bjornpagen/devtools/devtool`, `/run`, `/oxlint/rule`, `/oxlint/syntax` and `/oxlint/fixtures` stay.

#### A repository's own superlint rules (edullm)

edullm's `timeback-provider-boundary` (`packages/platform/lint/src/superlint/`) was the one own superlint rule, and it
read the checker. It becomes a rule of edullm's own oxlint plugin, made with `ownPlugin` from
`@bjornpagen/devtools/preset`, written with `@bjornpagen/devtools/oxlint/rule` and `/oxlint/syntax` and proven with
`/oxlint/fixtures`: from syntax and scope, it refuses the `fetch`, `URL` and `Request` globals (unshadowed) and
`HttpClientRequest` imported from Effect outside its `adapters`, and the provider's `addresses` and the `constants` its
options name (`TIMEBACK_*SERVER_URL`, `TIMEBACK_*TOKEN_URL`) outside them, or it is deleted. Then
`own: [edullmRules(...)]`, `packages/platform/lint/src/superlint/`, its `fixtures:superlint` task and the
`PROVIDER_ADDRESSES` exception go; the exception becomes an override of the new rule on `toolchain.config.ts`.

#### Every exemption's new home

- **grizzle**
  - `exceptions` no-module-state on `packages/engine/src/query/build/scope.ts` and `test/pg/serverless/support.ts`:
    an override with `"devtools/no-module-state": "off"`; `test/support/substrate/shared.ts` drops (the syntactic
    rule finds nothing there).
  - `exceptions` no-spread-argument on `test/unit/deps/runtime-probe.ts`: an override with
    `"devtools/no-spread-argument": "off"`.
  - `exceptions` ts-only-extensions on `upstream/v8-unicode-end-anchor-astral-class/repro.js`: stays, the workspace
    gate's.
  - `noEnvironment`: `environment: { library: ["packages/engine/src", "packages/grizzle/src"], readers:
    ["packages/grizzle/src/adapter/connection/environment.ts"] }`.
  - `noCaseList`: `"no-case-list"` with the searches and generators above and `cases: ["test/"]`; its dictionaries go.
  - `"no-raw-sql": { sources: [], writers: [] }`: the engine's SQL is strings its printer builds and the rule reads
    Drizzle `sql` templates only, so grizzle names none; its old cast guard has no successor.
  - no-spread-argument's `tuples`: `[{ module: "#test/support/list.ts", names: ["argumentsOf", "nonEmptyArgumentsOf"]
    }, { module: "#compiler/allen/atoms.ts", names: ["atomOperands"] }]`.
  - `testCaseIsSearch.exempt`: its five groups, with their reasons, become `examples.exempt` in `vitest.config.ts`
    and `vitest.network.config.ts` (both at the root, so the paths stay): the README mirror's blocks and examples
    tests, `test/unit/dev/package.test.ts`, `test/pg/bench/`, the type batch's population runners and the cost
    gates; add `test/pg/migrate/backfill-cost.test.ts`, a growth-cost gate that starts no search, which the lint's
    static reach let through. Its `scaffolds` (runSchedule) have no successor: a hand schedule run through
    `interleave` counts as a search. Decide what `scripts/dev/mutate/vitest.config.ts` states.
  - `uncheckedVocabularyLiteral`, `sqlTextAssertion` and `limitEvidence`: deleted.
  - New finding: `test/pg/compute/catalogue.test.ts:140-142` spreads `...integerRanges.int2` (and int4, int8), a
    property of an imported object the syntax cannot size: pass the two elements by index, or destructure them first.
- **den**
  - `core` and the grizzle pack's options: deleted, `grizzle()`.
  - `noCaseList`: `"no-case-list"` with its old `cases` list.
  - `testCaseIsSearch` (no exemptions): each package's Vitest config (den, den-vercel, den-model, edullm and the
    network config) takes `examples: { kind: "banned", exempt: [] }`.
  - `noEnvironment` named no files: `environment: { library: [], readers: [] }`.
- **superstarter**
  - `core`: deleted. `drizzle({ ... })`: `drizzle()`, its options moved as above.
  - `"no-raw-sql": { sources: ["packages/database/src"], writers: [] }`: rds.ts's IAM ARN pattern is a string, which
    the rule no longer reads, so its writer entry and the JSDoc on it go.
  - `examples: { kind: "allowed" }` in each Vitest config.
- **edullm**
  - `core`: deleted. `drizzle({ ... })`: `drizzle()`, its options moved as above.
  - `"no-raw-sql": { sources: ["packages/data/database/src"], writers: ["packages/data/database/src/sql/cast.ts"] }`:
    load.ts's ISO_INSTANT pattern is a string, which the rule no longer reads.
  - `QTI_PIE_SETTINGS` (`effect-free-packages` on `packages/qti-pie/`): stays, the workspace gate's.
  - `PROVIDER_ADDRESSES` and `own`: as "A repository's own superlint rules" says.
  - If the root oxlint reaches `packages/qti-pie`, sql-raw-execution refuses the pg `client.query` at
    `pantry/src/cli/timeout.db.test.ts:108`: add the file to `nativeClientOwners`, or leave qti-pie to its own config.
  - `examples: { kind: "allowed" }` in each Vitest config, qti-pie's included.
- **effect-openapi-cli-generator**
  - `core`: deleted. `plugin` gains `"no-raw-sql": { sources: [], writers: [] }` and `"no-spread-argument":
    { tuples: [] }`; `environment: { library: [], readers: [] }`; `examples: { kind: "allowed" }`.

#### What the rules see now that they read syntax alone

- no-module-state judges a module-level binding by what is written: a `let` or `var`; a constant holding an array
  literal, an object literal with a writable property, a `new Map` or `new Set`, or a regular expression with the g
  or y flag, unless a readonly type, `as const` or `Object.freeze` says otherwise; a write to the global object the
  file does not declare. It follows the file's own aliases and interfaces and takes another module's type at its
  word, so `const pool = new Pool()` passes.
- no-null-undefined-union reads written types (parameters, properties, return types) through the file's own aliases,
  no longer inferred returns or aliases from other modules.
- no-case-list no longer follows lists imported from support modules.
- The drizzle rules and no-raw-sql know Drizzle by import: a `sql` template is Drizzle's when its tag is imported
  from drizzle-orm, and a value is Drizzle's or pg's when the file traces it to such a call, instance or annotated
  type. A value imported from another module cannot be followed (name views through no-bare-materialized-view-joins'
  `modules`, handles through no-drizzle-write-without-where's `receivers`), and `sql<Alias>` is read as written.
- The environment bans refuse an imported value at its import rather than where it is read, and ban
  `globalThis.process` and `navigator` in the library wholesale.
- Scans of today's trees with the final rules: den and superstarter 0 findings; grizzle 3 to fix (catalogue.test.ts
  above) beside the ones its overrides cover; effect-openapi-cli-generator 35 (27 no-spread-argument, such as
  `Math.max(...rows.map(...))` and `pending.push(...Arr.reverse(...))` in emit/ and runtime-src/; 7 no-module-state,
  `new Set`, `new Map` and g-flag regular expressions in runtime-src/runtime/sequential.ts, client.ts and output.ts,
  to annotate ReadonlySet or ReadonlyMap or unflag; 1 no-null-undefined-union, test/names/flatten.test.ts:19);
  edullm about 1,935, of which about 1,290 are in the .agents, .claude and .cursor skill copies (ignore patterns) and
  583 in qti-pie.

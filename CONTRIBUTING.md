# Contributing to the toolchain

The toolchain is two workspace packages, `@bjornpagen/devtools` and `@bjornpagen/testing`, which every repository
takes as the submodule `vendor/toolchain`. This file says how the checks run, here and in every repository that takes
the toolchain; README.md says what a repository changes to take it.

## When each check runs

| When                                | Command                   | What runs                                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After every edit                    | `pnpm types`              | `turbo run typecheck`: each package's and the root's incremental typecheck. A re-check reads the project's build info and checks only what changed, so it takes seconds when little did, and turbo replays a package whose inputs did not change at all. |
| Each commit (lefthook's pre-commit) | `toolchain-gate commit`   | On a snapshot of what the index holds, side by side: `pnpm types`, `oxfmt --check` of the staged files, and the AST-only oxlint on the staged JavaScript and TypeScript files. No lint builds a TypeScript program. The target is 10 seconds or less.    |
| Each push (lefthook's pre-push)     | `toolchain-gate push`     | `pnpm check` on a snapshot of each commit the push sends: the typecheck from scratch (`typecheck:full`, `--incremental false`), the type-aware oxlint, the format check, dead code, the lockfile's dedupe, the repository-wide checks and the fixtures.  |
| By hand                             | `pnpm check`, `pnpm test` | The full gate over the working tree, and the tests, which no hook runs.                                                                                                                                                                                  |

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
  `src/oxlint/fixture-rules.ts` and its place in the preset's `PLACES`; a rule for one repository only goes to that
  repository's own plugin (`ownPlugin`);
- to the workspace gate (`packages/devtools/src/workspace/`), when it reads the repository's JSON or file names;
- to the testing library's reporter, when it judges what a test did at run time.

A rule that needs the checker and fits none of these is a decision for the owner, not a new program.

## The gate: snapshots

`toolchain-gate` (`packages/devtools/bin/gate.sh`) runs a check on exactly one snapshot of the repository, never on the
working tree, so lanes that share one checkout never fail or pass each other's work in progress:

- `toolchain-gate commit` is the commit gate; `toolchain-gate push`, with lefthook's `use_stdin`, is the push gate,
  which reads the commits a push sends from git's pre-push lines; `toolchain-gate run <index|commit> <command>` runs
  any command on what the index holds or on a commit (`toolchain-gate run index pnpm check` is the old
  `scripts/check-staged.sh`).
- A snapshot is a directory under `${XDG_CACHE_HOME:-~/.cache}/toolchain-gate/<the checkout's hash>/` that git keeps in
  step with an index of its own (`read-tree --reset -u`): a run rewrites only the files that changed, deletes the ones
  that went, and keeps what `.gitignore` names (node_modules, the build info, the tools' caches), so the install and
  the incremental typecheck stay warm. It installs with `pnpm install --frozen-lockfile --offline`, so a lockfile
  change must be installed in the working tree first, which fills the store.
- git leaves a submodule's gitlink an empty directory; the gate fills each from the submodule's own repository at the
  commit the snapshot records, and leaves a submodule the working tree never checked out empty, as it is there.
- The commit gate and the push gate keep separate snapshots, so a commit, which holds `.git/index.lock` for its whole
  hook, never waits on a push's full gate. Runs on one snapshot take turns.
- Turbo's cache is the working tree's (`.turbo/cache`) unless `TURBO_CACHE_DIR` names one, so a task the working tree
  already ran on the same content is a hit in the snapshot, and the other way round: `pnpm types` after the last edit
  makes the commit gate's `pnpm types` a replay.

The hooks call lefthook and the gate by path (`node_modules/.bin/lefthook`, `sh packages/devtools/bin/gate.sh`), not
through `pnpm exec`, whose dependency check refuses to run anything while another lane's manifest change waits for its
install.

A snapshot directory is safe to delete when no gate is running; the next run builds it again.

## Throughput knobs

A machine that many runs share caps each one through the environment. Unset, every tool behaves as it did before
these knobs. Each takes a whole number above zero and is refused otherwise; turbo passes each through to its tasks
without hashing it, since none changes a result. beefy-workspace sets the machine-wide values on cassowary.

| Variable                   | What it caps                                                                                 | Read by                                 |
| -------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| `TOOLCHAIN_TEST_WORKERS`   | Vitest's test files at once (`maxWorkers`)                                                   | the testing library's `workers.ts`      |
| `TOOLCHAIN_TSGOLINT_PROCS` | the cores of tsgolint, the Go program that runs oxlint's type-aware rules (its `GOMAXPROCS`) | `toolchain-oxlint`                      |
| `TOOLCHAIN_TS_CHECKERS`    | tsrs's type checkers per project (`--checkers`)                                              | `toolchain-typecheck`                   |
| `TURBO_CACHE_DIR`          | where turbo keeps its cache: one directory shared by every clone of a repository             | turbo, and the gate, which passes it on |

Never set `cacheDir` in turbo.json: a machine-wide `TURBO_CACHE_DIR` is what lets clones share one cache.

# toolchain

The dev tools and the testing library that Bjorn's TypeScript repositories share, as one pnpm workspace:

- `@bjornpagen/devtools` (`packages/devtools`): the oxlint preset and plugin (every lint rule, each reading syntax
  alone), the tsconfig bases, the fixtures that prove every rule, and the commands `toolchain-gate`,
  `toolchain-typecheck`, `toolchain-oxlint`, `workspace-gate` (the repository-wide tsconfig, manifest and file-name
  checks) and `superstyle` (a Tailwind app's stylesheet contract). No check builds a TypeScript program but the
  typecheck.
- `@bjornpagen/testing` (`packages/testing`): the choice-stream testing library on Effect and Vitest.

A repository takes the toolchain as the submodule `vendor/toolchain`, pinned at a commit; its pnpm workspace lists
`vendor/toolchain/packages/devtools` and `vendor/toolchain/packages/testing`, so both run from source, and it keeps
its own decisions in `toolchain.config.ts`. How the checks run is in CONTRIBUTING.md.

## Consumer migration: the check pipeline (2026-11-14)

What a repository changes to take the toolchain from the check-pipeline plan on (Bjorn's plan and decisions of
2026-11-14). Each part names the commits that bring it. Pin `vendor/toolchain` at a commit whose README holds this
whole section, and do every part: the parts are one migration, in the order a repository can typecheck them.

### 1. Dependencies (ad8d0ec, 3a4a777, 175689e)

- The catalog's versions: `@effect/tsgo` 0.69.0 (tsrs 0.25.0) with `typescript` 7.1.0-beta, `oxlint` 1.93.0,
  `oxlint-tsgolint` 7.0.2007, `turbo` 2.11.11, `vitest` 5.1.0, `oxfmt` 0.78.0, `fallow` 3.43.0 or later,
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

- A tsconfig that extends `vendor/toolchain/packages/devtools/tsconfig.base.json` is incremental already. A repository
  base of its own sets `"incremental": true` and
  `"tsBuildInfoFile": "${configDir}/node_modules/.cache/typecheck.tsbuildinfo"` and keeps `"noEmit": true`; drop any
  `"incremental": false`. A composite project that emits declarations keeps its own `tsBuildInfoFile`.
- `node_modules/` must be gitignored (it is in every repository).
- Each package's scripts: `"typecheck": "toolchain-typecheck"`, `"typecheck:full": "toolchain-typecheck --incremental false"`,
  `"oxlint": "toolchain-oxlint"`. Arguments pass through (`toolchain-typecheck -b`, `toolchain-typecheck -p
  tsconfig.json`).
- The root's scripts: `"types": "turbo run typecheck"` (with the repository's `--filter`s), `"typecheck":
  "toolchain-typecheck"`, `"typecheck:full": "toolchain-typecheck --incremental false"`, and `check` runs
  `typecheck:full` in place of `typecheck`.
- turbo.json: a `typecheck:full` task with the `typecheck` task's `dependsOn` and `inputs`, and `//#typecheck:full`;
  `NODE_OPTIONS` moves from `globalEnv` to `globalPassThroughEnv`. Never set `cacheDir`.
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
        run: sh vendor/toolchain/packages/devtools/bin/gate.sh push
        use_stdin: true
  ```

  The commit gate needs the root's `types` script and `oxlint.ast.config.ts`; the push gate runs the root's `check`.

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
    `"union"`, and `@bjornpagen/testing/explore`'s `drawn` and `sketched` `"each"`, each as
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

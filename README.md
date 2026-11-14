# toolchain

The dev tools and the testing library that Bjorn's TypeScript repositories share, as one pnpm workspace:

- `@bjornpagen/devtools` (`packages/devtools`): the oxlint preset and plugin, the tsconfig bases, the repository-wide
  checks, the fixtures that prove every rule, and the commands `toolchain-gate`, `toolchain-typecheck` and
  `toolchain-oxlint`.
- `@bjornpagen/testing` (`packages/testing`): the choice-stream testing library on Effect and Vitest.

A repository takes the toolchain as the submodule `vendor/toolchain`, pinned at a commit; its pnpm workspace lists
`vendor/toolchain/packages/devtools` and `vendor/toolchain/packages/testing`, so both run from source, and it keeps
its own decisions in `toolchain.config.ts`. How the checks run is in CONTRIBUTING.md.

## Consumer migration: the check pipeline (2026-11-14)

What a repository changes to take the toolchain from the check-pipeline plan on (Bjorn's plan and decisions of
2026-11-14). Each part names the commit that brings it. Do the parts in order; the last part, superlint's retirement,
comes from the plan's finalizer.

### 1. Dependencies (ad8d0ec)

- The catalog's versions: `@effect/tsgo` 0.69.0 (tsrs 0.25.0) with `typescript` 7.1.0-beta, `oxlint` 1.93.0,
  `oxlint-tsgolint` 7.0.2007, `turbo` 2.11.11, `vitest` 5.1.0, `oxfmt` 0.78.0, `fallow` 3.43.0 or later,
  `effect`, `@effect/platform-node` and `@effect/vitest` 4.1.4, `tailwindcss` 4.3.5, `vite` 8.3.8, pnpm 12.18.0
  (`@babel/core` and `@tailwindcss/node`, which only the old style linter and React Compiler check loaded, go in part 4).
  A pin newer than the repository's `minimumReleaseAge` allows waits a day.
- Babel 8 carries its own types: drop `@types/babel__core`.
- @effect/tsgo 0.69.0 ships two new Effect diagnostics, `missingConcurrencyOption` and `onExitFailureToOnError`. Every
  tsconfig that restates the `@effect/language-service` plugin lists both at `"error"`, as the shared base does, unless
  the owner rejects one in `toolchain.config.ts`'s `rejected.diagnostics` with its reason.
  `missingConcurrencyOption` refuses every `Effect.forEach` and `Effect.all` without a `concurrency` option: add
  `{ concurrency: 1 }`, the sequential run it had by default (or a wider one where that is meant), to the options
  object, or as a new last argument.
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
  `"passThroughEnv": ["TOOLCHAIN_TS_CHECKERS"]` on both typecheck tasks and their root tasks,
  `"passThroughEnv": ["TOOLCHAIN_TSGOLINT_PROCS"]` on `oxlint` and `//#oxlint`, `TOOLCHAIN_TEST_WORKERS` in `test`'s
  `passThroughEnv`; `NODE_OPTIONS` moves from `globalEnv` to `globalPassThroughEnv`. Never set `cacheDir`.
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

### 5. superlint's retirement

The finalizer of the plan completes this part: every superlint rule's new home (an oxlint rule, a mapping or a
deletion), the config keys each repository drops from `toolchain.config.ts`, and the removal of the superlint tasks,
scripts and dependencies.

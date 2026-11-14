# Merging the five dev-tools copies: the conflicts

The copies are superstarter's, edullm's, the CLI generator's, grizzle's and den's `devtools`. This file lists every
place where two copies changed in different directions. Bjorn decides each one. Each item says what each copy does,
who it changes things for, which fixtures prove each side, and what I recommended.

**Decided (Bjorn, 2026-11-14):** every item exactly as recommended, C1 to C17 and D1 to D2, C12 (a) included. The CLI
generator drops `web` as well as `drizzle`, since it has no React. grizzle's main has since gained the oxlint rule
`side-effect-free` (847cc104, a226cbac), a plain addition, which joins the `grizzle` pack.

## The decisions at a glance

Each is explained below. The recommendation is in brackets.

- **C1** How JSON text is written: grizzle's `shared/json.ts` [grizzle's].
- **C3** Packages under `vendor/` leave a repository's own tsconfig gate [yes].
- **C4** oxlint plugin rules join packs `core`, `drizzle`, `grizzle` and a new `web` [yes; the CLI generator
  drops `web`?].
- **C5** `brands-sole-mint` catches the union of both copies' forms [union].
- **C6** The Temporal message [grizzle's].
- **C7** The Effect-free block's input [directories, from the config].
- **C8** A test file is `.test.ts` or `.test.tsx` [both].
- **C9** The testing plugin loads at the root [root].
- **C10** Style options are keyed by app root [keyed].
- **C11** Stylesheet roles are superstarter's, with edullm's `layeredImports` added [both].
- **C12** edullm's book and caption rules: edullm's own local style rules, or option-driven shared rules
  [edullm's own].
- **C13** Option paths match from the repository root [root].
- **C14** `unchecked-vocabulary-literal` reads superstarter's way [superstarter's].
- **C15** The one-plugin-block and Effect-free checks are in `core` or optional [core].
- **C16** The roster's source and name, and the options-file checks [grizzle's; both checks].
- **C17** Messages that name one repository [the general text].
- **D1** How the tools load `toolchain.config.ts`: one dynamic import, excepted for one file in the toolchain's
  own oxlint config, or a self-link, or data-only [the one dynamic import].
- **D2** The shared tsconfig base sets every diagnostic to error, and each repository's root tsconfig holds its own
  offs [yes].

## What was taken without asking

Where one copy is just an older state of another, the newer one is taken (decision 3):

- **The CLI generator** is superstarter as of 2026-11-11 (b2606f6), taken 36 seconds before superstarter's fb43038.
  It is behind on no-module-state holding test files (c0f9423), on `Array.from` for `Arr.makeBy` (fb43038) and on the
  testing plugin's every-file rules. Superstarter's files are taken.
- **den** is grizzle as of 2026-11-11 morning. It is behind on the repository-wide rules taking exceptions
  (cc530e80), on no-module-state holding test files (b2c5c2ba), on no-case-list dropping the testing library's
  `filter` (80118e39) and on the testing plugin's every-file rules (fdb641e0). grizzle's files are taken. den's
  no-case-list fixture still has a `filter` case; the testing library that lane A2 merges has no `filter`
  (superstarter and grizzle deleted it).
- **edullm is behind superstarter** on these:
  - `no-spread-argument` and `unchecked-vocabulary-literal` (the proposal already decided that edullm gains them);
  - `eslint/prefer-spread` in REJECTED, which came with no-spread-argument;
  - the four oxlint rules superstarter took from grizzle on 11-04 (`brands-sole-mint`, `import-doors`, `no-try`,
    `no-new-error`);
  - the testing plugin's clock and every-file blocks;
  - no-module-state holding test files;
  - superstarter's markup doors (40aa2f5);
  - `rule.ts`'s `TypeNode`.

  edullm gains all of them. For edullm this is stricter lint, which its CLAUDE.md allows. Its adoption lane (F5) fixes
  what they find. One of them makes a real difference: `markup` reports an empty `style={{}}` at a measured file,
  which edullm's copy accepts.

- **edullm is ahead of superstarter** on `shared/repository.ts`: it handles several Tailwind apps (`apps`, 11-08),
  where superstarter handles one. edullm's is taken; with one app it behaves as superstarter's.
- **grizzle is ahead of the others** on these:
  - `shared/semantic.ts` and the new `shared/nodes.ts` (11-09): the syntax walk keeps no call stack, so no depth of
    nesting can overflow it;
  - `shared/devtool.ts` (`failureFrom`);
  - `shared/native-api.ts`: grizzle's is superstarter's with `nativeSession` and `openProject` exported. Superstarter
    deleted `nativeSession` only because it had no use there, and grizzle's `scripts/dev` use both, so they stay.
- **grizzle's superlint engine is ahead on these**, and they are taken:
  - the repository-wide rules (`rejected-diagnostics`, `ts-only-extensions`) take the repository's exceptions
    (cc530e80). grizzle's options have one (`ts-only-extensions` for an upstream `repro.js`); under any other copy's
    engine that options file fails to load;
  - rules start once per program and can read its public surface (`--pending` and `gate: "pending"`, used by
    `no-optional-public-input`);
  - fixture sets can nest (`limit-evidence/mirror`, `no-environment/entry`, …).
    One fix goes with it. grizzle reads every package's `exports` as its public surface on each run. In edullm that
    fails the run in `packages/platform/pipeline` (`"./*"`) and `packages/data/retest-loop-analysis`, so the merged
    engine reads the surface only when a rule that uses it runs.
    The first family's rules start as `() => visit`, unchanged. The `app database` family becomes the `drizzle` pack:
    the CLI generator's `appDatabase: "none"` means it doesn't run that pack (decision 6).
- **A test file is linted by every rule.** superstarter (c0f9423) and grizzle (b2c5c2ba) both did this on 11-11, by
  the owner's order. edullm, the CLI generator and den still skip test files for no-module-state, so they will get
  no-module-state findings in their tests. The number is not yet measured.
- **Which sources are linted:** edullm's rule (skip generated folders and each app's vendored shadcn folder). With no
  app it is grizzle's.
- **Each family's own rules** go into packs, unchanged: the 16 SQL and Drizzle rules into `drizzle`, the 7 grizzle
  rules into `grizzle`. edullm's `timeback-provider-boundary` and `tutor-truth-column` become edullm's own rules in
  its config, with their fixtures.

## Conflicts in shared code

**C1. How JSON text is written** (`shared/native-api.ts`, the tsconfig overlay).

- **superstarter:** calls `jsonTextOf` from its own workspace package, `@superstarter/json`. A shared package can't
  depend on that.
- **edullm and grizzle:** use `shared/json.ts`'s `jsonEncoder`, which encodes through a Schema.
- **Either way:** the bytes written are the same.
- **Recommend:** grizzle's `shared/json.ts`. It is the one that works without superstarter's package.

**C2. Where the repository root is found.** This is not between copies: the submodule forces it.

- **Every copy:** walks up from where the dev tools sit to the nearest `pnpm-workspace.yaml`.
- **The problem:** vendored at `vendor/toolchain/packages/devtools`, that walk finds the toolchain's own
  `vendor/toolchain/pnpm-workspace.yaml`, not the consumer's.
- **Done:** the walk now starts from the working directory. No copy behaves differently in its own tree.

**C3. Vendored packages in a repository's own gate.**

- **Today:** den lists `vendor/grizzle/packages/*` in its workspace, so den's superlint holds grizzle's tsconfigs to
  den's REJECTED_DIAGNOSTICS.
- **After the merge:** every consumer vendors the toolchain the same way. The toolchain's own tsconfigs follow the
  toolchain's settings, not the consumer's.
- **Recommend:** superlint's workspace scan skips packages under `vendor/`. A vendored package is checked by its own
  repository's gate.

## Conflicts in the oxlint preset and plugin

**C4. Which plugin rules a repository runs.**

- **Today:** every copy's preset turns on every rule its own plugin has.
- **What breaks with one plugin:** the merged plugin has the union, 24 rules (edullm's `tutor-truth-column` becomes edullm's own). Turning all of them on everywhere adds
  findings that exist today:
  - `no-collation` fires in grizzle, at `packages/engine/src/core/limits.ts:383`
    (`'x' COLLATE pg_catalog.pg_c_utf8`);
  - `bearer-owners` (empty owners refuse every `Bearer ${…}`) fires in den, at `packages/den-vercel/src/census.ts:34`.
- **Recommend:** oxlint plugin rules join the same packs as superlint's, and the config names the packs. Each
  repository then runs exactly the rules it runs today, apart from edullm's gains listed above.
  - `core`: the 12 rules in all five, plus `brands-sole-mint`, `import-doors`, `no-try` and `no-new-error`.
  - `drizzle`: `no-collation`.
  - `grizzle`: `no-raw-sql`, `test-no-prose-search` and `test-no-spelled-names`. The two test rules hold only in test
    files, as in grizzle's preset.
  - A fourth pack, `web`: the React, jsx-a11y and Next plugins, the 15 React-family rules, and the plugin's
    browser-app rules `bearer-owners`, `no-send-beacon`, `no-svg-without-title` and `no-unoptimized-next-image`.
    superstarter and edullm run it. grizzle and den don't load those plugins today, and the CLI generator has them
    only because it is a copy of superstarter: it has no app.
- **Decide:**
  - Are packs the right unit for oxlint rules too, or should each repository list its plugin rules one by one?
  - Is `web` the right name?
  - Does the CLI generator drop `web`, as it drops `drizzle` (decision 6)?

**C5. The `brands-sole-mint` rule.**

- **superstarter:** catches `Brand.nominal`, `Brand.make` and `Brand.check` with the brand as their one type
  argument, and `Schema.brand("B")`.
- **grizzle:** catches `Brand.nominal<B>()` with no arguments, grizzle's own bare `nominal<From, B>()`, and
  `Schema.brand("B")`.
- **Recommend:** the union. Both fixture sets pass under it. It adds no finding today in any repository: there is no
  `Brand.make<`/`Brand.check<` in grizzle or den, and no bare `nominal<X, Y>()` in superstarter or the CLI generator.
- Its fixtures keep both copies' cases, and `import-doors` keeps superstarter's fuller fixtures, which grizzle's
  rule (identical code) passes.

**C6. The Temporal ban's message.** Three texts, written the same afternoon:

- **superstarter:** "Temporal is banned: time goes through Effect's Clock and DateTime, so a test controls it."
- **grizzle:** "Temporal is banned: time goes through Effect's Clock and DateTime, and in Effect-free code through
  what the code is handed."
- **edullm:** "Time goes through Effect's Clock and DateTime, not the Temporal global."
- **Recommend:** grizzle's. It is the only one that also covers Effect-free code, which the preset has.

**C7. The Effect-free block's input.**

- **superstarter:** directories, taken from `superlint.effectFree`.
- **grizzle:** globs (`["packages/engine/**"]`).
- **The lists differ in order:** grizzle `[...list, ...metrics, Math.random]`, superstarter
  `[...list, Math.random, ...metrics]`.
- **The rules are the same either way.** Only grizzle's list is non-empty today.
- **Recommend:** superstarter's directories, read from the one config (grizzle's becomes
  `effectFree: ["packages/engine"]`), in grizzle's order.

**C8. What a test file is.**

- **superstarter, edullm and the CLI generator:** `.test.ts` and `.test.tsx`.
- **grizzle and den:** `.test.ts` only.
- **Recommend:** both suffixes. grizzle and den have no `.test.tsx`, so nothing changes for them.

**C9. Where the testing plugin loads.**

- **superstarter and grizzle (11-11):** load it at the root for its every-file rules.
- **edullm, the CLI generator and den:** load it inside the test and clock blocks. These are the older copies.
- **Recommend:** at the root, which is the newer. The lint results are the same; only the config's JSON differs.

## Conflicts in the style linter

The style linter is in superstarter, edullm and the CLI generator only. They split from one package on 2026-10-26
(285d600):

- superstarter took edullm's book rules out the same evening (bbc5a71), by the owner's ruling that rules existing
  only for one repository leave the shared package;
- both then went on separately.

**C10. Options for one app or several.**

- **superstarter:** one un-keyed `superstyle` value.
- **edullm (11-08):** keys its value by app root, because it has two apps (`packages/product/nextjs-app`,
  `packages/product/qti-app`). It runs in the app's directory.
- **Neither decodes the other's value.**
- **Recommend:** keyed by app root. superstarter's value moves under `"packages/nextjs-app"`; with one app it behaves
  as today. A repository with no app (CLI generator, grizzle, den) has an empty map.

**C11. How a stylesheet is given its role.**

- **superstarter (11-04):** gives each sheet one role (app, scoped, passthrough) up front.
  - A sheet named twice fails the run.
  - A sheet with no role is reported at 1:1.
  - A passthrough sheet with other text gets its own message.
  - The longest scope wins when one scope is inside another.
- **edullm:** decides inside the stylesheet rule.
  - A sheet named twice is linted under its first match.
  - A wrong passthrough falls through to the "second theme or component CSS owner" message.
  - Scopes are taken in the options' order.
- **edullm alone (11-09):** has `layeredImports`, the one `@layer theme, base, …, components, utilities;` line and
  `@import "…" layer(…)` after it, which qti-app's `globals.css` uses. Superstarter's rule refuses both lines.
- **Recommend:** superstarter's roles (newer and stricter) plus edullm's `layeredImports`. The two don't contradict.
  The only changes for edullm are the messages above and the doubly-named failure, which no option of edullm's
  triggers.

**C12. edullm's book and caption rules.** edullm has `book-units` and `book-caption`, plus about 600 lines of support:

- the `--u` unit, `@property --u`, `@utility book-unit`, the `book-small` variant and book tokens in the stylesheet
  rule;
- caption tables read through the checker.

superstarter removed them by the 10-26 ruling. **Two ways to keep them:**

- **(a) edullm's own local style rules,** in its config. The style engine then needs a way to host local rules:
  - open rule ids;
  - an options slice per local rule;
  - a step that reads the program and the stylesheet;
  - class rules that see each class's compiled declarations and the theme's variables (superstarter deleted both);
  - hooks in the stylesheet rule for the book's at-rules.
- **(b) Keep them in the shared engine** as option-driven rules (`books`, `captions`), which do nothing where the
  lists are empty. This reverses the 10-26 ruling.
- **Recommend:** (a). It follows the ruling and the approved design, where a repository's own rules live in its
  config. It is the biggest single piece of the merge. Until it lands, edullm keeps its own style linter.

## Conflicts in superlint

**C13. How a path in the options names a file.**

- **The first family:** a suffix match anywhere in the absolute file name, case-sensitive, so `"scripts/"` also
  takes `packages/testing/scripts/fuzz.ts`.
- **grizzle and den (11-05, 24006319):** match from the repository root, ignoring case (the checker may lower-case a
  declaration's path), so `"scripts/"` is only the root's scripts folder.
- **The fixtures can't tell them apart.** The trees can:
  - under suffix matching, grizzle's limit-evidence scope `["bench/", "scripts/"]` would also take
    `packages/testing/scripts/*.ts`;
  - in the first family's trees, every path in the options already names a real file from the root (45 in
    superstarter, 49 in edullm, 1 in the CLI generator), and no tracked file is matched by suffix alone.
- **Recommend:** grizzle's root-anchored matching. It changes nothing in the first family's trees. It does change
  nine rule files' calls: 7 drizzle rules, timeback-provider-boundary and unchecked-vocabulary-literal.

**C14. What `unchecked-vocabulary-literal` reads.** Both came from grizzle's rule; superstarter widened it on
11-04 (8483c0c).

- **The files read.**
  - superstarter: every test file, plus the `support` paths.
  - grizzle: only the `files` paths.
- **What a vocabulary is.**
  - superstarter: a type alias, an interface or a class, and the `_tag` of tagged errors among them
    (`{ module, type }`).
  - grizzle: a type alias of strings only (`{ module, alias }`).
- **A vocabulary module the file's program doesn't hold.**
  - superstarter: says nothing (in a workspace of many packages, most programs don't hold it).
  - grizzle: reports it as a misconfigured option.
- **The fixtures.**
  - Under grizzle's rule, superstarter's fixtures fail: lines 22, 24, 28, 30 and 38 (classes and `_tag`) are
    missed, and clean.ts gets a report for the class `TodoNotFound`.
  - Under superstarter's rule, grizzle's fixtures pass: its 6 vocabularies are all unions of strings.
- **Recommend:** superstarter's. grizzle and den rename `files` to `support` and `alias` to `type`.
  - What grizzle loses: the report for an unheld vocabulary module, which no fixture proves.
  - What grizzle gains: its 25 test files under `packages/testing/src` join the files read. When the testing
    library moves to the toolchain, they leave grizzle.
  - Both fixture sets stay; grizzle's becomes a nested set.

**C15. The tsconfig gate: how much it holds.**

- **superstarter (11-04, `tsconfigs.ts`):**
  - the root tsconfig declares the Effect plugin exactly once (`effect-plugin-block`);
  - every package's tsconfig extends the root, or the Effect-free base for a package listed in
    `superlint.effectFree`, whose package.json then names nothing of Effect's (`effect-free-packages`);
  - three workspace fixtures prove it.
- **edullm and grizzle:** have only the diagnostic checks, inline in `lint.ts`.
  - Under superstarter's checks, these draw findings today: grizzle's engine package (`"plugins": []`), its
    grizzle package (it restates the plugin), den, and edullm's three `vendor/qti-pie` packages.
  - superstarter's tsconfig reader also refuses an `extends` that is a list, which grizzle's and den's root
    tsconfigs use. That is fixed either way: the merged reader takes a list.
- **Decide:** either these checks go into `core`, and grizzle, den and edullm reshape their tsconfigs during
  adoption, or they are an option (`effectFree` plus a switch) that superstarter and the CLI generator turn on, which
  keeps every repository as it is today.
- **Recommend:** into `core`. The one-plugin-block rule is what makes D2 work, since each repository's offs then
  sit in exactly one place.

**C16. The gate's small differences.**

- **Where the roster comes from.**
  - superstarter and edullm: `<root>/node_modules/@effect/tsgo/oxlint-presets`.
  - grizzle: resolves `@effect/tsgo` from the dev tools and also fails on an empty roster.
  - **Recommend** grizzle's. Vendored, the dev tools resolve the consumer's @effect/tsgo either way.
- **The roster finding's name.**
  - superstarter and edullm: `rejected-diagnostics`.
  - grizzle: its own name, `diagnostic-roster`.
  - **Recommend** grizzle's separate name. No repository's exceptions name either today.
- **Checks on the options file.**
  - superstarter: the vocabulary paths exist.
  - grizzle: the test-case-is-search scaffold modules exist.
  - **Recommend:** both, each run only by the pack that owns the option.

**C17. Message texts that name one repository.**

- **`no-spread-argument`'s suggestion.**
  - superstarter: "append it with a for-of loop or Arr.appendAll, or fold it (Arr.reduce, Arr.max)".
  - grizzle: names grizzle's own helpers ("core/array.ts appendAll", "maxOf, minOf").
  - **Recommend** superstarter's, the one that holds everywhere.
- **`test-case-is-search`'s message.** It names `@grizzle/testing` (`@den/testing` in den). It becomes
  `@bjornpagen/testing`.
- **`no-module-state`'s doc comment.** The first family also says Drizzle declares its table columns writable.
  **Recommend** keeping it: that rule's exemption covers Drizzle's columns.

## Design questions the merge raises

**D1. How the tools read the config file.**

- **What's needed:** the approved design puts each repository's packs, REJECTED lists, options and own rules in one
  typed file at its root (`toolchain.config.ts`).
  - oxlint reads it through the repository's `oxlint.config.ts`, which imports it.
  - superlint, superstyle and the React Compiler check are programs that must load it at run time from the
    repository they run in.
- **The obstacle:** that is a dynamic `import()` of a computed path. The plugin's own `no-dynamic-imports` rule
  refuses it, because its allowed list takes only a literal specifier.
- **(a) One sanctioned load.** The one loader file, `src/shared/config.ts`, imports `<root>/toolchain.config.ts`. The
  exception lives in the toolchain's own oxlint config as an override for that one file, as CLAUDE.md says exceptions
  live, never inline.
- **(b) A fixed name.** Every repository's root package.json links itself under one name
  (`"@bjornpagen/toolchain-config": "link:."`, with `exports` pointing at its `toolchain.config.ts`). The tools then
  import that name statically. No rule is excepted, but each root carries the self-link.
- **(c) Data only.** The config holds only data (JSON). A repository's own rules stay in a small package of its own,
  whose bin wraps the shared engine. That gives two `superlint` bins in edullm.
- **Recommend:** (a).

**D2. REJECTED_DIAGNOSTICS and the shared tsconfig base.**

- **Today:** each copy's `tsconfig.base.json` sets exactly its own REJECTED_DIAGNOSTICS off, and superlint holds every
  tsconfig, the base included, to that list.
- **What changes:** once the base is shared and the list is per repository, the base can't match every repository.
  grizzle and den reject `preferSchemaTaggedError`; the other three don't.
- **Recommend:**
  - the shared base sets every diagnostic of the installed @effect/tsgo to error and is held to that roster;
  - each repository's root tsconfig declares the plugin once, with its own offs, as superstarter's already does;
  - superlint holds every tsconfig of the repository to the repository's REJECTED_DIAGNOSTICS.
- **Nothing rejected changes.** All five roots already restate all of the installed @effect/tsgo's 146 severities.
  grizzle, den and edullm restate the plugin in more tsconfigs than the root (C15).

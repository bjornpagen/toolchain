# Merging the testing library: where the copies diverged both ways

The merge reads each repository's committed HEAD: superstarter `325004a` (its testing library as of `27abc2a`),
edullm `87f0cb19d`, the CLI generator `cc23a5b`, grizzle `9e2b6584` (the library as of `395f1ddf`) and den
`12744a9`. Names are compared with each copy's scope taken out (`@superstarter/testing`, `grizzleTestingCoverage`,
`"den.testing.run"` and the like).

## How the copies are related

- **den** is grizzle's library at `36101770` (2026-11-09) with `grizzle` renamed to `den`, and nothing else. grizzle
  is a plain evolution of it.
- **The CLI generator** is superstarter's library at `e8645db` (2026-11-11), byte for byte. superstarter is a plain
  evolution of it.
- **superstarter and grizzle** were byte-identical on 2026-11-05 (superstarter `1448b86`, grizzle `a39357c6`). Since
  then grizzle has 40 commits of its own, and superstarter has 6: five on 2026-11-11 that grizzle made the same
  change for that day, and `27abc2a` today.
- **edullm** followed superstarter until 2026-11-05, skipping some of its commits (the witness phases `81ecf46`,
  `isCaseDiscarded`). Since then it has one commit of its own, `2a1e46f40` (2026-11-10).

So the merge starts from grizzle's library. Below are the changes another copy has and grizzle lacks, where grizzle
has changed too.

## Decisions

Bjorn approved all eight as recommended on 2026-11-14, and the package carries them. edullm took superstarter's
`27abc2a` change as `0e586b10a`, so points 1, 2 and 7 match both of them.

1. **How many test files run at once** (`vitest/config.ts`).
   - superstarter `27abc2a`, from the test-parallelism plan you ratified (edullm's `0e586b10a` is the same): no
     `maxWorkers` field, always `"100%"`, one worker a core.
   - grizzle and den: a `maxWorkers: Option<number>` field. Every grizzle and den config passes `Option.none()`,
     which is Vitest's default of one core left idle.
   - **Recommended: superstarter's.** For grizzle, den and qti-pie this is one more worker and one less field.

2. **How a window of cases runs** (`explore.ts`, `windowOf`).
   - grizzle: one case at a time starts on the search's own fiber; concurrent cases each start on a turn of their own,
     once the search holds their fiber. `settlingOrder` then puts cut cases last.
   - superstarter `27abc2a`: once a lower case of a window has failed or hung, no case above it starts. Cut cases
     still go last. Its hung-cleanup test waits out one 5 s grace instead of four.
   - **Recommended: both.** grizzle's way of starting cases, with superstarter's stop. A search finds the same cases
     either way.

3. **A key generator with fewer keys than the array needs** (`gen.ts`, `uniqueArray`).
   - grizzle: throws a plain `Error`, and its test checks only that the draw failed.
   - superstarter: throws `UniqueKeysExhausted`, a tagged error carrying `held` and `needed`, and its test checks both
     numbers.
   - **Recommended: superstarter's error,** with its check added to grizzle's test.

4. **The mutation tester's flags** (`scripts/mutate.ts`).
   - grizzle's tester is the newest (`--test`, `--kept`, the probe that refuses a target no test loads, the bin).
   - superstarter `27abc2a` defaults `--workers` to one mutant a core, where grizzle's default is 1.
   - edullm has `--config <vitest config>`, because enrollment's suite is `vitest.enrollment.config.ts`.
   - **Recommended: grizzle's tester with both flags.**

5. **Which requirements an exhaustion still lacks** (`explore.ts`'s `exhaust`, `features.ts`).
   - edullm `2a1e46f40` reads the unreached requirements from the tally being filled (`pendingIn`, `keysOf`,
     `TallyBuilder.has`), with each requirement's key built once.
   - grizzle copies the whole tally before every case.
   - The answer is the same; edullm's does less work.
   - **Recommended: edullm's,** in grizzle's `exhaust`.

6. **Importing `@effect/platform-node`** (`vitest/run.ts` and the tests).
   - edullm imports `NodeFileSystem` and `NodeServices` from their own subpaths.
   - grizzle and superstarter import the whole package. edullm measured about 1 s of import saved in every test
     process.
   - edullm's gate accepts the subpath imports under the same Effect diagnostics the toolchain has.
   - **Recommended: edullm's.**

7. **The coverage-guided steering test** (`steer.test.ts`).
   - superstarter `27abc2a` moves it to `steer-by-coverage.test.ts`, a process of its own, so the other steering tests
     no longer share a process with its one-at-a-time climb.
   - grizzle has rewritten `steer.test.ts` as properties, and the climb is still in it.
   - **Recommended: grizzle's tests,** with the climb moved to its own file as superstarter did. This goes with
     superstarter's new window test (2), which joins grizzle's `explore.test.ts`.

8. **Names that carried a repository's name.**
   - These are the run key and the mutated-file key Vitest provides, the two `globalThis` slots (coverage and the
     watchdog), the temporary-directory prefixes, and the mutation tester's bin. qti-pie calls `grizzle-mutate`
     today.
   - **Recommended: the new scope's name, as each copy did with its own:** `bjornpagen.testing.run`,
     `bjornpagen.testing.mutated`, `bjornpagenTestingCoverage`, `bjornpagenTestingWatchdog`,
     `bjornpagen-testing-…`, and the bin `bjornpagen-mutate`.

## Not decisions: what a consumer will see change

These are plain evolutions, so the newer side is taken. They're listed so that no consumer's behaviour changes
without anyone knowing.

- **The guard module goes** (`guardHook`, `waitingOnShared`, `LayerHung`). grizzle deleted it on 2026-11-08 because
  it had no caller. It still has none in any of the five repositories. superstarter, edullm and the CLI generator
  still ship it, unchanged, and their own `guard.test.ts` goes with it.
- **A set comparison holds each item once.** In grizzle's `oracle.ts`, `set(key, item)` takes a key (`structuralHash`
  for `exact`). A repeated item on either side is now a difference, and `multiset` is gone.
  - edullm calls `multiset` twice and `set` in four suites. Its adoption must rewrite those calls, and any answer that
    repeats an item will fail.
  - The other consumers don't use the oracle.
- **Generate-and-filter is gone everywhere:** `filter`, `Case.assume`, `Source.discard`, and an exhaustion's limit.
  - Superstarter and grizzle removed them on 2026-11-11, by your order. An exhaustion counts its whole space and races
    the count against the test's deadline.
  - den and edullm still have them, and their adoptions must construct cases instead.
- **The `exclusive` project goes.** superstarter and grizzle removed it, since every config listed it empty.
- **edullm and den move forward to the shared library,** and pick up everything they skipped.
  - edullm skipped superstarter's witness phases, the deadline-bounded exhaustion, `uniqueArray(key, itemOf, size)`
    and one recorder per loop.
  - den skipped grizzle's work since 2026-11-09: the shrinker, `failure.ts`, the commands API, the risk bound,
    `NoSerialOrder`, interleaving's deadlock record, and the lint rules searched over drawn programs.
- **The lint plugin is grizzle's.**
  - superstarter's rules are already byte-identical to it.
  - The one exception is `no-ordered-unordered`'s message. It names grizzle's `set(structuralHash, exact)`, where
    superstarter's names `multiset`.
  - Every copy's rule tests pass against it except two of edullm's. `no-fixed-seed` no longer reports a literal
    stream (`sample(generator, 7, 100)`, `caseSeed(3, index)`), because a stream is a branded type now, so the type
    checker refuses those calls before the rule would.
- **Every search states its oracle.** `oracle` is a required field of an exploration and an exhaustion, and the
  report prints it. superstarter's and the CLI generator's suites state none today.
- **Generators draw differently.**
  - A choice among options is `pick`, uniform however wide. Before, it was `choose`, which leans to the ends.
  - A drawn swarm always turns one feature on.
  - So a seed or a `TEST_REPLAY` token from an old copy names a different case. To reproduce an old failure, draw
    it again.
- **Other API changes, in the order adoption will meet them:**
  - `generate` takes the recorder it records on;
  - `program` takes the swarm it draws under, and a `Machine` names its refusals;
  - `mutantsOf` takes families;
  - interleaving's judge fails with its own refusal, no longer wrapped in `InterleavingFailed`;
  - `WildTouched` carries a `touch`;
  - `features`/`noFeatures` are `required`/`noCoverage` (edullm's copy predates the rename).

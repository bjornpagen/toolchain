---
name: indefensible-numbers
description: Use when adding, reviewing or removing a number that bounds concurrency, retries, timeouts, intervals, batch or page size, a pool, a budget, a depth, hop or visit count, or a capacity, and first to decide whether that cap should exist at all; when a bound's JSDoc lacks its @limitKind evidence; when a library would choose a number for its caller; when the user says magic number, indefensible number, limit, throttling, empirical cap or measure it.
---

# Indefensible numbers

A number that bounds something is a limit, and a limit needs evidence. A name and a rationale do not defend it, and
neither does a JSDoc that says "reasonable" or "tuned". Every bound is **published**, **measured** or **derived**, or
it is a **provisional** debt that says so; anything else is an indefensible number, and it goes. And before any of
that, a cap must earn its existence: most caps that lack evidence guard nothing, and are deleted rather than defended.

A limit is a plain constant next to the code it bounds, its evidence in its JSDoc. There is no limits package, no
`Limit` type and no lint rule: review holds the policy.

## Should this limit exist at all?

Ask this first, before you classify or document anything. Writing evidence for a cap keeps revealing caps that should
never have existed, and a cap that guards nothing is not made safe by documenting it: it is deleted. In order:

1. **Is it a fact of something outside our code**, a vendor quota, a protocol constant, a platform maximum? Keep it,
   as `published`.
2. **Does it protect a shared resource from untrusted input**, a public endpoint's body size, a multi-tenant queue's
   depth? Keep it, `measured` or `published`, and name the threat in its `@scope`.
3. **Is it a genuine operating point that changes behaviour**, a batch size, a concurrency width, a timeout on
   something that can really hang, that a measurement supports? Keep it, `measured`; or, if nothing is better, use the
   tool's own default (`published`, as a configurable default) or the data's own bound.
4. **Otherwise, delete it.** A defensive cap on our own data or on trusted input protects nothing. Where the code
   genuinely cannot handle a size, fix the representation, not the number: cycle detection instead of hop and visit
   caps, an iterative walk instead of a depth cap, streaming instead of a buffer cap. Truncating text loses
   information: delete the truncation.
5. **Only a cap that guards something real but has no evidence yet is `provisional`**, and it must name what it guards,
   in `@guards`. "Just in case" names nothing.

Worked examples, one of each outcome:

- **Deleted.** effect-openapi-cli-generator resolved an OpenAPI document under `maxNodes: 10_000_000`, a cap on the
  nodes of a document its own user chose to generate from. Its user is the only one who could feed it a huge document,
  and the cap only turns their large document into an error. Trusted input, our own data: the cap goes, with no
  replacement.
- **Replaced by the representation.** The same resolver followed `$ref` chains under `maxHops: 64`, which stops a cycle
  by counting instead of seeing it, and refuses a legitimate chain of 65. It already tracks the chain it is on
  (`onChain`), so a cycle is detected exactly when a reference repeats; the hop cap goes, and the cycle is a typed
  error naming the reference that closes it.
- **Published.** A Vercel Function on the Pro plan runs at most 800 s (`https://vercel.com/docs/functions/limitations`,
  "Pro and Enterprise: 300s default, 800s maximum"): a fact of the platform, `published` with `@constraint hard quota`.
  A route's own `maxDuration` is the application's choice under that maximum, checked against it.
- **Measured.** A bulk loader's batch of 500 rows per INSERT is an operating point between one round trip per row and a
  statement too large for the server: measure rows per second at 50, 200, 500, 2,000 and 5,000 on the real table and
  machine, keep the smallest batch past which throughput stops rising, and record the run in `measured`'s seven tags.
- **Provisional.** The gate polls a snapshot's lock once a second: without a wait between looks, a waiting run spins a
  CPU for a whole `pnpm check`. That names what it guards, and nobody has measured the delay yet, so it is
  `provisional` with the measurement planned in `@measure`.

## What a limit is, and what it is not

A **limit** is a number the code bounds something by that someone could have chosen differently: how many at once,
how many times, how long, how often, how big, how much. `concurrency: 4`, `retries: 3`, `timeoutMs: 5000`,
`Schedule.spaced("1 second")`, `{ max: 10 }` on a pool, a page size, a batch size, a TTL, a deadline, a buffer's first
capacity.

**Not a limit**, needing no evidence:

- `0` anywhere;
- `1` anywhere but a time: one item, one attempt and one step are identities, while one second, one minute or one day
  is a choice;
- `-1` in a comparison or counting from the end;
- a data length and index arithmetic against it (`xs.length`, `text.slice(i + 2, i + 6)`, `items.length - 1`);
- a factor that scales, shifts, masks or reduces data (`ms * 1000`, `b & 0x3f`, `n % 2`, `2 ** k`, `x << 10`);
- an exact unit conversion named for its two units (`millisPerSecond = 1000`, `daySeconds = 86_400`; `dayMs = 86_400`
  is wrong);
- a code unit or a bit pattern, written in hexadecimal, binary or octal (`c >= 0x30`, `0b1010`);
- a member of a closed vocabulary (a binding typed `0 | 1 | 2`);
- a format's defining width or layout, a declaration whose JSDoc names the format with `@formatConstant`
  (`@formatConstant a SQLSTATE: five characters`, a shared-memory layout's slots);
- a test's own times, widths and sizes: a test's inputs are its own. `bench/` is no test: a benchmark's time limits,
  sample counts and workload sizes are limits.

**A number the machine reports is read where it is needed, never written down**: `availableParallelism()`, a cgroup's
quota, `os.totalmem()`. It is a fact of the run, not a choice; a width computed from it (one worker a CPU, mutants over
the processes one holds) is a plain function of the report, not a derived limit.

**A choice is its owner's input.** Before you defend a number, ask whose choice it is. A library takes a pool's size, a
timeout, a page size or a concurrency from its caller, **required and with no default**: never `options.max ?? 10`,
never `(ms = 250) =>`, never a constant the library picks on the caller's behalf. Delete the default rather than
document it. Check the input against the published limit that bounds it (a timer's delay from 1 to `timerMaxMillis`)
and name that range in the refusal. A library keeps only the limits of its own machinery, numbers no caller could
sensibly choose (grizzle's LATERAL threshold, the testing library's watchdog grace), and the application that calls it
keeps the rest beside its own code.

## Where a limit lives, and how its evidence is written

A limit is a `const` in the module that uses it; when several modules of a package read it, in the one that reads it
most, and the others import it; when several packages read it, in the lowest package the others depend on. A module of
constants gathered from elsewhere (a `limits.ts`) is no home: the reader of a bound should find its evidence where the
bound acts. A function that decides by a threshold takes the threshold as a parameter where a test drives that
decision with a smaller value; production passes the constant.

The JSDoc above the constant says what it bounds, where it is refused and why that is the place, then its evidence as
tags. Every kind starts with four:

- `@limitKind published`, `measured`, `derived` or `provisional`;
- `@owner` who sets it: another system by its pinned version ("PostgreSQL 19.0", "Node 26.13.1's timers"), or the
  code's own unit by file and function ("the testing library (live.ts's watchdog)");
- `@unit` what it counts, plural: "milliseconds", "bound parents", "steps of a decision's range";
- `@scope` exactly what one instance of the bound covers: "each case a search runs on a process's main thread", not
  "cases". A per-instance pool or semaphore is not an account-wide cap: every serverless instance and every worker
  holds its own.

Then its kind's tags. The tags are prose: review opens each.

### published

A number another system states.

```ts
/**
 * The longest counted repetition PostgreSQL's regex compiler accepts: str.regex refuses a pattern past it.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0's regex compiler
 * @unit repetitions
 * @scope each bound of a counted repetition in one str.regex pattern
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/regex/regguts.h#L95
 * @quote #define _POSIX2_RE_DUP_MAX 255
 * @verified 2026-11-27
 */
export const regexMaxRepeat = 255
```

- `@source`: an `https://` URL pinned to the exact release the code runs (a tag, a versioned docs path), anchored to
  the line that states the number. A moving branch is no source.
- `@quote`: that line, verbatim and short.
- The value is written as the source spells it (`2 ** 29 - 24` for `(1 << 29) - 24`), so the two compare at a glance.
- `@constraint`, one of five, naming what the number really is: `hard quota`, `protocol constant`,
  `compile-time constant` (a define of the build), `configurable default` (a setting's default the code runs under:
  say "default" in the scope) and `advisory threshold`. A vendor default is not a maximum, and an example or an
  advisory in a vendor's guide is an advisory threshold, not a quota.
- `@verified`: the day you opened the source and checked the number, `YYYY-MM-DD`. A repin re-verifies and re-dates it.

When a source states the number only as a formula over another, write the other `published` and this one `derived`,
quoting the formula with its URL and date in `@derivation`.

### measured

An operating value a measurement supports. All seven tags, each a sentence or more:

- `@evidence`: a resolvable record of the measurement, not a claim of success: the run's files in the owning package's
  uncommitted run output (`out/`, `bench/results/`) with the command that writes them, or authorized provider
  telemetry by its query. No credentials, personal data or raw sensitive errors.
- `@observed`: the actual interval, with its timezone.
- `@environment`: the machine (name, instance class, CPUs, memory), its load, the runtime and library versions, the
  provider, region, plan or account scope, the revision.
- `@workload`: the operation, its input size and population, batching and aggregate concurrency.
- `@result`: the sample size or duration, throughput, latency, throttles and errors, resource pressure, and which
  metrics are missing. Distinguish unique operations from duplicated log lines and retries.
- `@decision`: how the value follows from the result, with any headroom stated, and the unmeasured gap between the
  chosen point and the next measured one.
- `@revalidate`: what invalidates it: an upgrade, another machine, another region or plan, a workload or concurrency
  change, newly observed throttling.

A guess, an experiment's starting width and "seemed fast" are not measurements. An observed failure threshold is not an
operating point. A measured value cannot override a lower published quota.

### derived

Arithmetic over other limits.

```ts
/**
 * The largest message the frontend/backend protocol carries.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0's frontend/backend protocol
 * @unit bytes
 * @scope one message from client to server, as its Int32 length counts it
 * @derivation PQ_LARGE_MESSAGE_LIMIT, which libpq.h defines as MaxAllocSize - 1 (<pinned URL>, verified 2026-11-14)
 * @from {@link maxAllocSize}
 */
export const messageMaxBytes = maxAllocSize - 1
```

- The initializer reads the limits `@from` names, and every other number in it is an identity, a unit conversion or a
  data length. Do not hide an invented factor or reserve inside an otherwise sourced formula; a derived constant that
  reads no limit is a number with evidence of its own: write it as that kind.
- `@derivation`: why this arithmetic bounds this resource.
- Arithmetic on a limit elsewhere that makes a new bound (`limit * 2` as a timeout) is a new derived limit: write it as
  one.
- When an input is re-verified or remeasured, read what derives from it.

### provisional

A protective cap no evidence defends yet. It exists so that work stays bounded while the evidence is found; it is a
debt, never an authority.

```ts
/**
 * How many decisions one mutation of a case edits in place, at most, before its one structural edit (mutate.ts).
 *
 * @limitKind provisional
 * @owner the choice-stream testing library (mutate.ts, a case's mutation)
 * @unit point edits
 * @scope one mutation of one case's tape
 * @guards without a most, a mutation's run of point edits, which halves in likelihood with each, could edit a tape all
 *   over, so a mutant would keep nothing of the seed it came from
 * @measure fuzz the library's plants for a fixed budget with at most 1, 2, 4 and 8 point edits a mutation, several
 *   seeds each, and keep the most that turns the most plants red soonest
 * @origin written with no evidence before the testing library came into this repository as one package in 20b4112
 *   (2026-11-13), from grizzle's, superstarter's and edullm's copies
 * @recorded 2026-11-16
 */
const pointEditsMax = 4
```

- `@guards`: what the cap guards, the unbounded work, wait or growth it stops. If it names nothing, or only "just in
  case", the number is no protective cap: delete it, or make it the caller's input.
- `@measure`: how the number will be defended: the measurement to run (on which machine, at which candidate values,
  deciding by what), or the source to find.
- `@origin`: where the number came from as it stands: the commit that wrote it, an old record whose revalidation fired.
- `@recorded`: the day the debt was written down.

Write `provisional` only for a cap that passed the five questions above: it guards something real, which it names, and
nothing published, measured or derived states its number yet. Never rename a guess into one of the other kinds. A
measured record whose `@revalidate` has fired (another machine, an upgrade) is no longer measured: measure it again if
that takes minutes, or demote it to provisional and cite the old record in `@origin`; never call stale evidence
`measured`.

Provisional debt is paid down, not carried: when you touch a provisional limit's owner, run its `@measure` if you can,
and write the result as `measured` (or the source as `published`). `rg '@limitKind provisional'` lists the debt.

## A limit outside TypeScript

A shell script, a SQL migration or a config in another language keeps its limit where it takes effect, with the same
tags in that language's comments: a script's own number is a `readonly` at its top, its evidence above it. A settings file a deployment installs holds the literal; where a comment there would change what is
installed, the code that installs it carries the evidence. A number TypeScript also reads keeps its evidence in the
TypeScript that defines it, and the other copies point there.

## How to measure: a worked example

The testing library's watchdog grace (`watchdogGraceMillis`) is how long the main thread may go unanswered past a
case's hang moment before the watchdog ends the process. Its old record was taken on a retired macOS VM, so its
revalidation ("a different machine") had fired. It was measured again on cassowary in about a minute:

1. **Name what the number decides.** The grace separates a live case that is merely slow (it answers a ping when its
   synchronous segment yields) from one that never yields. So the quantity to observe is the latency of a live main
   thread's answer under realistic synchronous work.
2. **Build the smallest faithful probe**, in the owning package's uncommitted run output, with the command that
   reproduces it: `packages/testing/out/watchdog-grace/<stamp>/probe.mjs` has a worker ping the main thread exactly as
   the watchdog does (postMessage, the answer through shared memory) while the main thread runs synchronous segments of
   1 to 200 ms that allocate, between yields; `run.sh` runs it three times alone and four times at once, and records
   `uname`, `node --version`, `nproc` and `uptime` before and after.
3. **Run it on the machine the limit runs on, under its real load**, and keep every sample: 1,436 pings, each latency
   in the run's JSON files.
4. **Read the result honestly**: p50 46 to 49 ms, p99 197 to 200 ms, slowest 201 ms, every answer within the longest
   segment plus scheduling delay; and say what was not measured (the watchdog's own cost per case).
5. **Decide, stating the headroom**: 5 s is 24 times the slowest answer, so a live case may hold the thread for seconds
   past its moment; a case past its moment is a hang either way, so the grace only decides whose report it gets. Keep 5000.
6. **State what invalidates it**: a Node or V8 upgrade, another machine, a property that holds the thread for seconds,
   a watchdog report naming a case that yields.
7. **Write it** `measured` with all seven tags, and keep the suite that re-verifies its use (`blocking.test.ts`) green.

When a measurement would take hours, touch a shared database or a provider, or spend money, do not run it to defend a
number: write it `provisional` with the plan in `@measure`. This skill never authorizes a load test, spend, or a write
to a shared database or a source system. Measure only inside authorized traffic, stop increasing load when throttling,
latency collapse or failures appear, and never amplify an outage to find a ceiling.

## Backpressure, not dropped work

Bound in-flight work with Effect's scoped concurrency, `Semaphore`, `Pool` or rate-limiting primitives at the resource
owner. A concurrency bound controls in-flight work, not requests per second; a rate quota needs rate-aware admission or
a finite event budget that provably fits it, retries and lifecycle events included. Work a bound cannot admit is
refused with a typed error that names the bound, before the work is sent, never clipped or skipped. Queue overflow for
later; never truncate the population; batching preserves every admitted item. Retry only what a typed error says may
succeed when run again, and never an ambiguous write or a COMMIT whose outcome is unknown.

Do not delete an existing protective cap merely because its documentation is missing and thereby unleash unbounded
work: resolve its evidence, or write it provisional and report the missing authority.

## Review checklist

For every diff that touches a bound:

1. **Should it exist at all?** Run the five questions above on every number the diff adds, keeps or documents. A cap
   on our own data or trusted input, a hop, visit or depth cap where a representation would do, a truncation, a
   provisional limit whose `@guards` names nothing: delete it, or fix the representation.
2. **Classify each number** that stays: no limit (the list above), a machine report (read it), a choice (the caller's
   required input), or a limit. Hunt inline bounds, not only named constants:

   ```sh
   rg -n --glob '*.ts' --glob '*.tsx' --glob '!**/node_modules/**' --glob '!**/fixtures/**' \
     'concurrency:|times:|[Rr]etr(y|ies)|[Tt]imeout|[Bb]ackoff|millis|seconds|minutes|Schedule\.|max:|maxSockets' .
   ```

3. **No bare bound**: every limit is a named constant with its `@limitKind` JSDoc, including those in a comparison or a
   clamp (`depth > 8`, `Math.min(n, 100)`, `Date.now() - started > 5000`), in SQL or other text, or passed through a
   function.
4. **No default for a choice** (`?? 10`, `= 250`): a library takes it from its caller, required.
5. **Inside each JSDoc**: open a published source at its anchor and match quote and value; resolve a measured record or
   the command that reproduces it and check that `@decision` follows from `@result`; audit a derivation's inputs and
   factors; for a provisional limit, check that `@guards` names real unbounded work and `@measure` is a plan someone
   could run.
6. **Kind is honest**: no stale record called `measured`, no guess called anything but `provisional`, no published
   default called a maximum.
7. **The bound acts where it claims**: the resource it protects, its aggregation across instances and workers; and it
   lives beside that code, not in a module of constants.

A clean typecheck proves nothing about any limit's truth.

## Revalidation

A limit is as good as its evidence today. Revalidate:

- a **published** limit when its source is repinned (a new PostgreSQL, Node or provider version): re-open, re-quote,
  re-date `@verified`;
- a **measured** limit when any trigger in its `@revalidate` fires (an upgrade, another machine, a workload change,
  newly observed throttling): measure again, or demote it to provisional with the old record in `@origin`;
- a **derived** limit whenever an input changes: read everything that derives from it;
- a **provisional** limit whenever you touch its owner: run its `@measure` if it takes minutes, and write the result.

Report what you could not defend by path, limit, number and missing evidence. Never present a clean typecheck as proof
of a remote capacity.

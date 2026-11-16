---
name: limits
description: Use when adding, reviewing or removing a number that bounds concurrency, retries, timeouts, intervals, batch or page size, a pool, a budget, a depth, hop or visit count, or a capacity, and first to decide whether that cap should exist at all; when minting a Limit (published, measured, derived, provisional) or editing a packages/limits package; when no-bare-limit or limits-sole-mint refuses a line; when a library would choose a number for its caller; when the user says magic number, indefensible number, limit, throttling, empirical cap or measure it.
---

# Limits: indefensible numbers

A number that bounds something is a limit, and a limit needs evidence. A name and a rationale do not defend it, and
neither does a JSDoc that says "reasonable" or "tuned". This skill keeps the indefensible-numbers policy: every bound is
**published**, **measured** or **derived**, or it is a **provisional** debt that says so; anything else is an
indefensible number, and it goes. And before any of that, a cap must earn its existence: most caps that lack evidence
guard nothing, and are deleted rather than defended.

The mechanism is a value, not a comment. A limit is a `Limit` of `@bjornpagen/limit`: a frozen, branded record of its
number and its evidence, minted only in its codebase's limits package and read by its `.value`. Two oxlint rules hold
that by syntax. Review holds the rest.

Read your codebase's `packages/limits` README (or its `src/limits.ts` header where it has no README) before you mint
or move a limit: it names the package, its scope (`@<scope>/limits`), the data files it generates and anything the
codebase adds to this skill.

## Should this limit exist at all?

Ask this first, before you classify or mint anything. Turning caps into Limits keeps revealing caps that should never
have existed, and a cap that guards nothing is not made safe by minting it: it is deleted. In order:

1. **Is it a fact of something outside our code**, a vendor quota, a protocol constant, a platform maximum? Keep it,
   as `published`.
2. **Does it protect a shared resource from untrusted input**, a public endpoint's body size, a multi-tenant queue's
   depth? Keep it, `measured` or `published`, and name the threat in its scope.
3. **Is it a genuine operating point that changes behaviour**, a batch size, a concurrency width, a timeout on
   something that can really hang, that a measurement supports? Keep it, `measured`; or, if nothing is better, use the
   tool's own default (`published`, as a configurable default) or the data's own bound.
4. **Otherwise, delete it.** A defensive cap on our own data or on trusted input protects nothing. Where the code
   genuinely cannot handle a size, fix the representation, not the number: cycle detection instead of hop and visit
   caps, an iterative walk instead of a depth cap, streaming instead of a buffer cap. Truncating text loses
   information: delete the truncation.
5. **Only a cap that guards something real but has no evidence yet is `provisional`**, and it must name what it guards,
   in `breaks`. "Just in case" names nothing.

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
  "Pro and Enterprise: 300s default, 800s maximum"): a fact of the platform, `published` with `constraint: "hard
  quota"`. A route's own `maxDuration` is the application's choice under that maximum, checked against it.
- **Measured.** A bulk loader's batch of 500 rows per INSERT is an operating point between one round trip per row and a
  statement too large for the server: measure rows per second at 50, 200, 500, 2,000 and 5,000 on the real table and
  machine, keep the smallest batch past which throughput stops rising, and record the run in `measured`'s seven fields.
- **Provisional.** The gate polls a snapshot's lock once a second: without a wait between looks, a waiting run spins a
  CPU for a whole `pnpm check`. That names what it guards, and nobody has measured the delay yet, so it is
  `provisional` with the measurement planned in `measure`.

## What a limit is, and what it is not

A **limit** is a number the code bounds something by that someone could have chosen differently: how many at once,
how many times, how long, how often, how big, how much. `concurrency: 4`, `retries: 3`, `timeoutMs: 5000`,
`Schedule.spaced("1 second")`, `{ max: 10 }` on a pool, a page size, a batch size, a TTL, a deadline, a buffer's first
capacity.

**Not a limit**, needing no evidence and no mint:

- `0` anywhere;
- `1` anywhere but a time: one item, one attempt and one step are identities, while one second, one minute or one day
  is a choice;
- `-1` in a comparison or counting from the end;
- a data length and index arithmetic against it (`xs.length`, `text.slice(i + 2, i + 6)`, `items.length - 1`);
- a factor that scales, shifts, masks or reduces data (`ms * 1000`, `b & 0x3f`, `n % 2`, `2 ** k`, `x << 10`);
- an exact unit conversion named for its two units (`millisPerSecond = 1000`, `daySeconds = 86_400`; `dayMs = 86_400`
  is wrong, and refused);
- a code unit or a bit pattern, written in hexadecimal, binary or octal (`c >= 0x30`, `0b1010`);
- a member of a closed vocabulary (a binding typed `0 | 1 | 2`);
- a format's defining width or layout, a declaration whose JSDoc names the format with `@formatConstant`
  (`@formatConstant a SQLSTATE: five characters`, a shared-memory layout's slots).

**A number the machine reports is read where it is needed, never minted**: `availableParallelism()`, a cgroup's quota,
`os.totalmem()`. It is a fact of the run, not a choice; a width computed from it (one worker a CPU, mutants over the
processes one holds) is a plain function of the report, not a derived limit.

**A choice is its owner's input.** Before you defend a number, ask whose choice it is. A library takes a pool's size, a
timeout, a page size or a concurrency from its caller, **required and with no default**: never `options.max ?? 10`,
never `(ms = 250) =>`, never a constant the library picks on the caller's behalf. Delete the default rather than mint
it. Check the input against the published limit that bounds it (a timer's delay from 1 to `timerMaxMs.value`) and name
that range in the refusal. A library mints only the limits of its own machinery, numbers no caller could sensibly
choose (grizzle's LATERAL threshold, the testing library's watchdog grace), and the application that calls it holds
the rest in its own limits package.

## The four kinds and their evidence

Every kind states four things first:

- `value`: the number (`number`, or `bigint` for `Limit<bigint>`);
- `owner`: who sets it: another system by its pinned version ("PostgreSQL 19rc2", "Node 26.13.1's timers"), or the
  code's own unit by file and function ("the testing library (live.ts's watchdog)");
- `unit`: what it counts, plural: "milliseconds", "bound parents", "steps of a decision's range";
- `scope`: exactly what one instance of the bound covers: "each case a search runs on a process's main thread", not
  "cases". A per-instance pool or semaphore is not an account-wide cap: every serverless instance and every worker
  holds its own.

Then its kind's evidence. `@bjornpagen/limit` types each field; the types check only the shape, so review opens each.

### published

A number another system states.

```ts
export const regexMaxRepeat = published({
	value: 255,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "repetitions",
	scope: "each bound of a counted repetition in one str.regex pattern",
	constraint: "compile-time constant",
	source: "https://github.com/postgres/postgres/blob/REL_19_RC2/src/include/regex/regguts.h#L95",
	quote: "#define _POSIX2_RE_DUP_MAX\t255",
	verified: "2026-11-14"
})
```

- `source`: an `https://` URL pinned to the exact release the code runs (a tag, a versioned docs path), anchored to the
  line that states the number. A moving branch is no source.
- `quote`: that line, verbatim and short.
- `value`: written as the source spells it (`2 ** 29 - 24` for `(1 << 29) - 24`), so the two compare at a glance.
- `constraint`, one of five, naming what the number really is: `"hard quota"`, `"protocol constant"`,
  `"compile-time constant"` (a define of the build), `"configurable default"` (a setting's default the code runs under:
  say "default" in the scope) and `"advisory threshold"`. A vendor default is not a maximum, and an example or an
  advisory in a vendor's guide is an advisory threshold, not a quota.
- `verified`: the day you opened the source and checked the number, `YYYY-MM-DD`. A repin re-verifies and re-dates it.

When a source states the number only as a formula over another, mint the other `published` and this one `derived`,
quoting the formula with its URL and date in `derivation`.

### measured

An operating value a measurement supports. All seven fields, each a sentence or more:

- `evidence`: a resolvable record of the measurement, not a claim of success: the run's files in the owning package's
  uncommitted run output (`out/`, `bench/results/`) with the command that writes them, or authorized provider
  telemetry by its query. No credentials, personal data or raw sensitive errors.
- `observed`: the actual interval, with its timezone.
- `environment`: the machine (name, instance class, CPUs, memory), its load, the runtime and library versions, the
  provider, region, plan or account scope, the revision.
- `workload`: the operation, its input size and population, batching and aggregate concurrency.
- `result`: the sample size or duration, throughput, latency, throttles and errors, resource pressure, and which
  metrics are missing. Distinguish unique operations from duplicated log lines and retries.
- `decision`: how the value follows from the result, with any headroom stated, and the unmeasured gap between the
  chosen point and the next measured one.
- `revalidate`: what invalidates it: an upgrade, another machine, another region or plan, a workload or concurrency
  change, newly observed throttling.

A guess, an experiment's starting width and "seemed fast" are not measurements. An observed failure threshold is not an
operating point. A measured value cannot override a lower published quota. Limits that share one run spread one
constant object of its strings into each mint and state their own `decision`.

### derived

Arithmetic over other limits.

```ts
export const messageMaxBytes = derived({
	owner: "PostgreSQL 19rc2's frontend/backend protocol",
	unit: "bytes",
	scope: "one message from client to server, as its Int32 length counts it",
	from: [maxAllocSize],
	derivation: "PQ_LARGE_MESSAGE_LIMIT, which libpq.h defines as MaxAllocSize - 1 (<pinned URL>, verified 2026-11-14)",
	compute: ([alloc]) => alloc.value - 1
})
```

- No `value`: `compute` makes it from `from`, a non-empty tuple of the limits it reads, and must read them. A compute
  that returns a number of its own (`() => 5000`) is a number with evidence of its own: mint it as that kind.
- `derivation`: why this arithmetic bounds this resource.
- Every other number in `compute` is an identity, a unit conversion or a data length. Do not hide an invented factor or
  reserve inside an otherwise sourced formula.
- Arithmetic on a `.value` elsewhere that makes a new bound (`limit.value * 2` as a timeout) derives outside `derived`:
  mint the result.
- When an input is re-verified or remeasured, read what derives from it.

### provisional

A protective cap no evidence defends yet. It exists so that work stays bounded while the evidence is found; it is a
debt, never an authority.

```ts
export const gateLockPollSeconds = provisional({
	value: 1,
	owner: "the dev tools' gate (packages/devtools/bin/gate.sh, lock)",
	unit: "seconds",
	scope: "each wait of one gate run for the run that holds its snapshot's lock",
	breaks: "with no wait between looks a waiting run spins a CPU for as long as the other run holds the lock",
	measure:
		"time how long a waiting gate takes to start after the lock is let go, at polls of 0.1, 0.5, 1 and 2 s, and keep the longest whose delay stays a small share of the commit gate's run",
	origin: "written with the snapshot gate in e277d8d (2026-11-14), with no evidence",
	recorded: "2026-11-16"
})
```

- `breaks`: what the cap guards, the unbounded work, wait or growth it stops. If it names nothing, or only "just in
  case", the number is no protective cap: delete it, or make it the caller's input.
- `measure`: how the number will be defended: the measurement to run (on which machine, at which candidate values,
  deciding by what), or the source to find.
- `origin`: where the number came from as it stands: the commit that wrote it, an old record whose revalidation fired.
- `recorded`: the day the debt was written down.

Mint `provisional` only for a cap that passed the five questions above: it guards something real, which it names, and
nothing published, measured or derived states its number yet. Never rename a guess into one of the other kinds. A measured record whose `revalidate` has fired
(another machine, an upgrade) is no longer measured: measure it again if that takes minutes, or demote it to
provisional and cite the old record in `origin`; never call stale evidence `measured`.

Provisional debt is paid down, not carried: when you touch a provisional limit's owner, run its `measure` if you can,
and mint the result as `measured` (or the source as `published`). A codebase lists its provisional limits in one place
(its limits package); review counts them, and a new one needs the same scrutiny as deleting the cap would.

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
7. **Mint it** `measured` in the limits package with all seven fields, and keep the suite that re-verifies its use
   (`blocking.test.ts`) green.

When a measurement would take hours, touch a shared database or a provider, or spend money, do not run it to defend a
number: mint `provisional` with the plan in `measure`. This skill never authorizes a load test, spend, or a write to a
shared database or a source system. Measure only inside authorized traffic, stop increasing load when throttling,
latency collapse or failures appear, and never amplify an outage to find a ceiling.

## Where limits live

Every codebase keeps its own limits in one workspace package, `packages/limits`, named `<scope>/limits`
(`@bjornpagen/limits` for the toolchain, `@edullm/limits`, `@grizzle/limits`). It depends on `@bjornpagen/limit`
alone, uses no Effect, and holds every mint; code everywhere else imports a limit and reads `.value` where the bound
acts:

```ts
import { watchdogGraceMillis } from "@bjornpagen/limits"

export const WATCHDOG_GRACE_MILLIS = watchdogGraceMillis.value
```

A constant that holds exactly `someLimit.value` (or `BigInt(someLimit.value)`) is that limit, so the code that reads a
bound in many places may keep a local name for it. The JSDoc above a mint says what the limit bounds, where it is
refused and why that is the place; its evidence lives in the fields, never only in prose. A function that decides by a
threshold takes the threshold as a parameter where a test drives that decision with a smaller value; production passes
the limit.

**Read your codebase's `packages/limits` README** for its scope, its files and anything it adds.

## Backpressure, not dropped work

Bound in-flight work with Effect's scoped concurrency, `Semaphore`, `Pool` or rate-limiting primitives at the resource
owner. A concurrency bound controls in-flight work, not requests per second; a rate quota needs rate-aware admission or
a finite event budget that provably fits it, retries and lifecycle events included. Work a bound cannot admit is
refused with a typed error that names the bound, before the work is sent, never clipped or skipped. Queue overflow for
later; never truncate the population; batching preserves every admitted item. Retry only what a typed error says may
succeed when run again, and never an ambiguous write or a COMMIT whose outcome is unknown.

Do not delete an existing protective cap merely because its documentation is missing and thereby unleash unbounded
work: resolve its evidence, or mint it provisional and report the missing authority.

## The two lint rules

The dev tools' oxlint plugin runs both in the **limits pack**: a codebase turns them on when it adopts its limits
package, with `limits()` in `toolchain.config.ts`'s `packs` and the rules' options in `oxlint.config.ts`:

```ts
import { LIMIT_TESTS, standard } from "@bjornpagen/devtools/preset"

const LIMITS = { packages: ["packages/limits"], tests: LIMIT_TESTS } as const
// in lintConfig's plugin: "no-bare-limit": LIMITS, "limits-sole-mint": LIMITS
```

- **`devtools/no-bare-limit`** refuses a numeric literal in a governed place outside the limits package: the value of
  a variable, property, parameter default, class field, assignment or JSX attribute whose name carries bound
  vocabulary (concurrency, parallelism, permits, retries, retry, attempts, times, max, min, limit, cap, capacity,
  threshold, budget, batch, page, pool, window; any time unit or ms, timeout, interval, delay, ttl, deadline, grace,
  backoff); the arguments of `Duration.millis` and its kin, `Schedule.spaced`, `fixed`, `windowed`, `exponential`
  (both) and `recurs`, `Effect.timeout*`, `delay`, `sleep` and `withConcurrency`, a semaphore's permits, `setTimeout`,
  `setInterval` and `AbortSignal.timeout`; and a duration as text (`"5 seconds"`). It reads through `as`,
  `satisfies`, `??`, `?:`, `Math.min`, `Math.max`, an offset (`base + 500`) and a same-file constant that holds a
  number. The not-a-limit list above passes where syntax shows it: `0`, `1` as a count, a factor, an offset of a data
  length, hexadecimal, a unit conversion holding its ratio, a closed vocabulary, `@formatConstant`.
- **`devtools/limits-sole-mint`** refuses a call of `published`, `measured`, `derived` or `provisional` imported from
  `@bjornpagen/limit` outside the limits package, by name, renamed or off a namespace, and a re-export of them.

Both read syntax alone, so neither proves a limit true, and no-bare-limit cannot see a comparison's bound
(`depth > 8`), a number in SQL text or any string but a duration's, or a value that crosses a function boundary.
Review holds those (below).

**Test files are fully exempt from both**: `*.test.ts`, `*.test.tsx`, `*.fixtures.ts`, and every file beneath a `test/`,
`tests/` or `fixtures/` directory at any depth (`src/test/` too). A test's times, widths and sizes are its own inputs,
and a test may mint a Limit to drive the code it tests. `LIMIT_TESTS` is that list; a codebase passes its own
`tests: { suffixes, directories }` to narrow or widen it. **`bench/` is no test**: a benchmark's time limits, sample
counts and workload sizes are limits.

A refusal is fixed by minting the number in the limits package and reading `.value`, by making it the caller's input,
or, for a number the list says is no limit but syntax cannot show it, by writing it so it shows (a `@formatConstant`
JSDoc, a closed-vocabulary type). An oxlint override that turns a rule off for a file is the codebase's exception
block with a JSDoc reason, never an inline suppression.

## A limit outside TypeScript

A shell script, a SQL migration or a config in another language that needs a limit reads a data file the limits
package generates from its Limits, never a second spelling of the number. The limits package holds a generator
(`src/data.ts`) that writes the file, and a check, part of the codebase's `pnpm check`, that refuses the file when it
differs from what the generator would write. The toolchain's `packages/limits/limits.env` is the worked example: one
`NAME=value` line per limit, generated by `pnpm limits:data`, held by `limits:check`, and read by
`packages/devtools/bin/gate.sh` with `.` before it waits on a lock (`sleep "$GATE_LOCK_POLL_SECONDS"`). Commit the
generated file with the change to its Limits.

## Review checklist

For every diff that touches a bound or a limits package:

1. **Should it exist at all?** Run the five questions above on every number the diff adds, keeps or mints. A cap on our
   own data or trusted input, a hop, visit or depth cap where a representation would do, a truncation, a provisional
   limit whose `breaks` names nothing: delete it, or fix the representation.
2. **Classify each number** that stays: no limit (the list above), a machine report (read it), a choice (the caller's
   required input), or a limit. Hunt inline bounds, not only named constants:

   ```sh
   rg -n --glob '*.ts' --glob '*.tsx' --glob '!**/node_modules/**' --glob '!**/fixtures/**' \
     'concurrency:|times:|[Rr]etr(y|ies)|[Tt]imeout|[Bb]ackoff|millis|seconds|minutes|Schedule\.|max:|maxSockets|@limitKind' .
   ```

3. **No bare bound in a comparison or a clamp** (`depth > 8`, `Math.min(n, 100)`, `Date.now() - started > 5000`),
   in SQL or other text, or passed through a function: the rule cannot see these.
4. **No default for a choice** (`?? 10`, `= 250`): a library takes it from its caller, required.
5. **Inside each mint**: open a published source at its anchor and match quote and value; resolve a measured record or
   the command that reproduces it and check that `decision` follows from `result`; audit a derivation's inputs and
   factors; for a provisional limit, check that `breaks` names real unbounded work and `measure` is a plan someone
   could run.
6. **Kind is honest**: no stale record called `measured`, no guess called anything but `provisional`, no published
   default called a maximum.
7. **The bound acts where it claims**: the resource it protects, its aggregation across instances and workers.
8. **A generated data file** changed with its Limits, and its check passes.
9. **No `@limitKind` tag left**: the JSDoc tag mechanism is retired; a tag is an unminted limit.

A clean lint proves every bound reads a Limit, not that any Limit is true.

## Revalidation

A limit is as good as its evidence today. Revalidate:

- a **published** limit when its source is repinned (a new PostgreSQL, Node or provider version): re-open, re-quote,
  re-date `verified`;
- a **measured** limit when any trigger in its `revalidate` fires (an upgrade, another machine, a workload change,
  newly observed throttling): measure again, or demote it to provisional with the old record in `origin`;
- a **derived** limit whenever an input changes: read everything that derives from it;
- a **provisional** limit whenever you touch its owner: run its `measure` if it takes minutes, and mint the result.

Report what you could not defend by path, limit, number and missing evidence. Never present a clean typecheck as proof
of a remote capacity.

import { derived, measured, provisional, published } from "@bjornpagen/limit"

/**
 * The toolchain's own limits: every number the dev tools and the testing library bound something by, each with its
 * evidence (@bjornpagen/limit; the limits skill, packages/devtools/skills/limits). Code reads a limit's `.value`; the
 * dev tools' no-bare-limit and limits-sole-mint rules refuse a bound written or minted anywhere else. The ones a shell
 * script reads are in limits.env too, which src/data.ts generates from these and `pnpm check` holds to them.
 *
 * Each number was first asked whether it should exist at all (the skill's first section): a cap that guarded nothing
 * named was deleted, not minted (the recorder's first capacity, the engine bench's hang limit). What stays is the
 * watchdog's grace, measured; Go's fuzz status interval, published; and provisional caps, each guarding something it
 * names, with what breaks without it and how it will be measured. Most came with the testing library into this
 * repository in 20b4112 (2026-11-13), written with no evidence; the runner's budgets came with its runner (7a2cb07),
 * each the value most suites had stated; the report margin's measured record was taken on a machine since retired, and
 * its run output went with it.
 */

/** The day the provisional debts here were written down. */
const RECORDED = "2026-11-16"

/** Where a number that came with the testing library came from. */
const LIBRARY_ORIGIN =
	"written with no evidence before the testing library came into this repository as one package in 20b4112 (2026-11-13), from grizzle's, superstarter's and edullm's copies"

/**
 * How long the main thread may go without answering the watchdog once a case in flight has passed the moment its
 * guard would have stopped it (live.ts's watchdog). A live thread answers a ping as soon as the synchronous work it is
 * in yields, so this bounds how long a live case may hold the thread past that moment, not the case's hang limit. A
 * Node 26 thread cannot be stopped inside synchronous JavaScript without aborting the process, so a case that never
 * yields ends its process here, and this grace is what separates it from one that is merely slow.
 */
export const watchdogGraceMillis = measured({
	value: 5000,
	owner: "the choice-stream testing library (live.ts's watchdog)",
	unit: "milliseconds",
	scope:
		"every case a search runs on a process's main thread, once it is past its hang limit or its search's deadline",
	evidence:
		"packages/testing/out/watchdog-grace/20261116T064618/ in the toolchain's checkout on cassowary (/Users/bjorn/Documents/toolchain), the uncommitted record of `sh run.sh` there: probe.mjs, whose worker pings the main thread as the watchdog does (postMessage, the answer through shared memory) while the main thread runs synchronous segments that allocate, between yields; alone-1.json to alone-3.json and together-1.json to together-4.json, every ping's latency; runs.log and environment.txt. packages/testing/src/blocking.test.ts re-verifies the grace's use: its well-behaved bodies hold the main thread past their hang limit and are never ended, and its runaways end within their limit and this grace",
	observed: "2026-11-16 06:46:22 to 06:47:27 UTC",
	environment:
		"cassowary, Ubuntu 26.04.1 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with 64 logical CPUs and 247 GiB, Node 26.13.1; load average 105 to 155 from other sessions throughout",
	workload:
		"seven runs, three of 15 s one after another and four of 20 s at once; in each the main thread runs synchronous segments of 1, 5, 20, 50, 100 and 200 ms in turn, allocating throughout, and the worker sends its next ping after a random wait of 0 to 20 ms once the last is answered: 1,436 pings",
	result:
		"per run p50 46 to 49 ms, p99 197 to 200 ms, slowest 198.7 to 201.0 ms; the slowest answer of all 201.0 ms. A ping waits for the segment in flight, so every answer came within the longest segment, 200 ms, and the machine's scheduling delay. No errors; the watchdog's own cost per case was not measured again",
	decision:
		"5 s is 24 times the slowest answer seen and allows a live case a synchronous segment of seconds past its moment; a case past its moment is a hang whichever way it ends, so the grace only decides whether its verdict is the guard's typed one or the watchdog's report. Kept at the old record's value, whose slowest answer, 386 ms on a macOS VM loaded four to six times over its ten cores, shows the machine sets the latency",
	revalidate:
		"a Node or V8 upgrade; a different machine; a suite whose property holds the thread in one synchronous segment for seconds; a process the watchdog ended whose report shows a case that yields"
})

/**
 * How long before its test's deadline a search stops its work and reports (explore.ts's cut): the time from the moment
 * it is due to stop to the moment its test's function has failed with the report, which then beats the test's own
 * timeout. In it the search logs its report, then awaits the cleanup of every case it stopped.
 */
export const reportMarginMillis = provisional({
	value: 3000,
	owner:
		"the choice-stream testing library (explore.ts, a search's cut before its test's deadline)",
	unit: "milliseconds",
	scope: "every search under a bounded deadline (Run.deadline), in each test process alone",
	breaks:
		"a search would work up to its test's own timeout, which fails the test as a bare timeout: the smallest failing case a cut shrink reached, or the case a search had in flight, would go unreported; and a margin shorter than a stopped case's cleanup loses the typed failure to the timeout",
	measure:
		"re-run the old record's two measurements on cassowary: about 240 cut searches with reports of 1.6 KB and 68 KB and grizzle's write-oracle literal, four test files at once and while the library's whole suite runs, timing each from its cut to its failure leaving the test's logging; and grizzle's release of a stopped case's schema (DROP OWNED BY, DROP ROLE, DROP SCHEMA CASCADE) at the largest size a test held and at ten times it, ten runs each, on grizzle's PostgreSQL cluster. The margin is the slowest report and literal plus the longer of the slowest large release and three slowest test-sized ones, with its headroom stated",
	origin:
		"a measured record of 2026-11-04 to 2026-11-07 on a macOS (Darwin 27.0.0) arm64 VM on 10 cores, Node 26.13.0, Vitest 5.1.0, effect 4.1.2 and PostgreSQL 19rc1, load average 27 to 85 (packages/testing/out/print-margin/ in superstarter's and grizzle's checkouts there): reports at most 30 ms, the literal at most 87 ms, releases at most 2,186 ms large and 801 ms test-sized, about 2,520 ms in all, with 480 ms left for late timers. The machine changed, which its revalidation names, and its run output stayed with the VM, so the record no longer stands",
	recorded: RECORDED
})

/**
 * How long a search waits on a hung case's cleanup, on the live clock, before it reports the hang or goes on to its next
 * case (live.ts's awaitWithinGrace). The case stays among the fibers its search awaits before it returns, so a cleanup
 * past the grace delays the search's end and never outlives it.
 */
export const hungCleanupGraceSeconds = provisional({
	value: 5,
	owner: "the choice-stream testing library (live.ts, a hung case's cleanup)",
	unit: "seconds",
	scope:
		"the cleanup of each case a search stops as hung, before the search reports or runs its next case",
	breaks:
		"without it a search waits on a hung case's cleanup for as long as the cleanup takes, so a cleanup that itself hangs holds the hang's report, and the next case, until the test's own timeout",
	measure:
		"time the cleanup of every case the library's and the consumers' suites stop as hung (their releases: a fiber's finalizers, a database schema's drop), on cassowary, with the suites running at their usual width; the grace is the slowest cleanup seen, with its headroom stated, and never shorter than the slowest release the report margin is measured against",
	origin: LIBRARY_ORIGIN,
	recorded: RECORDED
})

/**
 * How often a fuzz run prints its progress (explore.ts), in milliseconds of wall time. The fuzz run is `go test -fuzz`'s
 * in this library (its -fuzztime grammar, its corpus), so it reports as often as Go's fuzzing coordinator does: often
 * enough that a person watching sees it move, and seldom enough that the status lines cost the run nothing.
 */
export const fuzzStatusEveryMillis = published({
	value: 3 * 1000,
	owner:
		"Go 1.27.4's fuzzing coordinator (go test -fuzz), whose status interval the library's fuzz run takes",
	unit: "milliseconds",
	scope: "the wait between two status lines of one fuzz run",
	constraint: "compile-time constant",
	source: "https://github.com/golang/go/blob/go1.27.4/src/internal/fuzz/fuzz.go#L205",
	quote: "statTicker := time.NewTicker(3 * time.Second)",
	verified: "2026-11-16"
})

/** How many decisions one mutation of a case edits in place, at most, before its one structural edit (mutate.ts). */
export const pointEditsMax = provisional({
	value: 4,
	owner: "the choice-stream testing library (mutate.ts, a case's mutation)",
	unit: "point edits",
	scope: "one mutation of one case's tape",
	breaks:
		"without a most, a mutation's run of point edits, which halves in likelihood with each, could edit a tape all over, so a mutant would keep nothing of the seed it came from",
	measure:
		"fuzz the library's plants for a fixed budget with at most 1, 2, 4 and 8 point edits a mutation, several seeds each, and keep the most that turns the most plants red soonest",
	origin: LIBRARY_ORIGIN,
	recorded: RECORDED
})

/** How far a nudge moves one decision of a mutated case, at most (mutate.ts). */
export const nudgeMax = provisional({
	value: 16,
	owner: "the choice-stream testing library (mutate.ts, a case's mutation)",
	unit: "steps of a decision's range",
	scope: "one nudge of one decision of a mutated case",
	breaks:
		"without a most, a nudge is a redraw anywhere in the decision's range, so a mutation could not explore the values beside one that reached something new",
	measure:
		"fuzz the library's plants for a fixed budget with nudges of at most 4, 16, 64 and 256 steps, several seeds each, and keep the most that turns the most plants red soonest",
	origin: LIBRARY_ORIGIN,
	recorded: RECORDED
})

/** Where the runner's budgets came from: what the suites stated to the library's old explore, surveyed. */
const SURVEY_ORIGIN =
	"surveyed 2026-11-16 with grep over the test trees of grizzle, den, edullm and the toolchain, when the runner (TESTSYS, 7a2cb07) replaced every suite's own number with one of its own: the value most of their statements chose, so a suite's search keeps the size it had. A survey of what authors chose is no measurement of what the number should be"

/**
 * How many independent cases a search's rotating stream runs (runner/limits.ts): the run's fresh sample, the only one
 * the residual estimates from, and its budget for finding failures under test.
 */
export const searchRuns = provisional({
	value: 150,
	owner: "the testing library's runner (runner/search.ts)",
	unit: "cases per search per run",
	scope: "one property's rotating stream in one run; every property runs its own",
	breaks:
		"without a budget a search's rotating stream draws cases until its test's deadline, so every test runs as long as it is allowed and its residual is estimated from whatever sample the clock left",
	measure:
		"run the suites of grizzle, den, edullm and the toolchain, with every kill (property.ts Kill) in, at 50, 150, 500 and 1,500 runs, several seeds each, and keep the smallest at which every kill fails its property, its run time stated beside",
	origin: `the median of the runs the suites stated to explore (934, 990 and 1,095 statements in grizzle, den and edullm; medians 150, 160 and 150); ${SURVEY_ORIGIN}`,
	recorded: RECORDED
})

/** How many cases a search's floor stream runs (runner/limits.ts): the witnesses the suite's identity fixes. */
export const floorCases = derived({
	owner: "the testing library's runner (runner/search.ts)",
	unit: "cases per search",
	scope: "one property's floor stream, the same on every run seed; every property runs its own",
	from: [searchRuns],
	derivation:
		"a quarter of the rotating stream's runs, rounded up: the library's explore ran its floor so, and keeping the rule keeps every suite's floor holding the witnesses it held",
	compute: ([runs]) => Math.ceil(runs.value / 4)
})

/**
 * How many cases a search's steered phase may run while a required situation is still unreached (runner/limits.ts):
 * mutants of the floor's finds, aimed at what is pending.
 */
export const steeredCases = provisional({
	value: 200,
	owner: "the testing library's runner (runner/search.ts)",
	unit: "cases per search, at most",
	scope: "one property's steered phase, which stops as soon as every required situation is reached",
	breaks:
		"a required situation no case can reach would keep the steered phase drawing until its test's deadline; the budget ends it, and the situation is reported unreached",
	measure:
		"record how many steered cases each required situation of the four repositories' suites takes to reach, over several seeds, and keep the budget above the slowest one reached, its headroom stated",
	origin: `the median steered budget the suites stated ({ cases: N, sense }, 2,493 statements; median 200); ${SURVEY_ORIGIN}`,
	recorded: RECORDED
})

/**
 * How many cases one steering window holds (runner/limits.ts): the cases drawn under one snapshot of what is pending,
 * which run at once. A constant of the runner, never of the machine, so one seed draws the same cases at any width.
 */
export const steeringWindow = provisional({
	value: 16,
	owner: "the testing library's runner (runner/search.ts)",
	unit: "cases per window",
	scope: "every window of every search",
	breaks:
		"with no window, every case of a search is drawn under the first snapshot of what is pending, so steering never moves; with a window of one, each case waits for the one before it to run and re-reads the snapshot",
	measure:
		"run the four repositories' suites at windows of 4, 8, 16 and 32 and record each required situation's steered cases to reach and each suite's run time; keep the window past which reaching takes more cases than the run time saves",
	origin: `the steerEvery 2,611 of 3,088 suites stated (8 in 223, 4 in 204, others fewer); ${SURVEY_ORIGIN}`,
	recorded: RECORDED
})

/**
 * How long one case may run before it is hung (runner/limits.ts): the runner-wide case deadline. The worker's guard
 * stops a case that yields past it, its watchdog ends a worker whose case holds the event loop past it, and the parent
 * kills a worker silent past it and its grace.
 */
export const caseDeadlineMillis = provisional({
	value: 60_000,
	owner: "the testing library's runner (runner/case.ts, runner/pool.ts)",
	unit: "milliseconds per case",
	scope: "every case of every property, on every worker",
	breaks: "a case that hangs would hold its worker, and its test, until someone stopped the run",
	measure:
		"record every case's run time across the four repositories' suites on cassowary over several runs, and keep the deadline above the slowest case that passed, its headroom stated; grizzle's whole-cluster lifecycles, the slowest known, may need a deadline of their own as a property's input",
	origin: `the caseHang 356 of 549 statements chose, one minute (69 chose 10 s, 63 chose 30 s, 31 chose 5 min, those grizzle's whole-cluster lifecycles); ${SURVEY_ORIGIN}`,
	recorded: RECORDED
})

/**
 * How long one need may take to open on a worker that has not opened it (runner/case.ts NeedCache): the open runs once
 * per worker per need key, when the worker readies the first property that needs it, before that property's first case
 * and outside every case's deadline. An open past it fails the property on that worker, once, as unopened; the parent
 * watches a readying worker for this long and its silence grace.
 */
export const needOpenMillis = measured({
	value: 300_000,
	owner:
		"the testing library's runner (runner/case.ts NeedCache, runner/worker.ts, runner/pool.ts)",
	unit: "milliseconds per need's open",
	scope:
		"each need's open on one worker, once per worker per need key; a property's needs open at once, each under it",
	evidence:
		"packages/testing/out/need-open/ in TESTSYS lane CORE-2's toolchain clone (~/.cache/grizzle-release/TESTSYS/CORE-2/toolchain), the uncommitted record of `GRIZZLE_PG_CLUSTER=5967 sh forms.sh forms-cold-1` and `... forms-warm-2`: forms.sh, instrument.patch (each worker appends one JSON line per property it readies, the readying's wall and CPU milliseconds), forms-uncited.patch (no property cites a case deadline of its own), and per run <name>.readying.jsonl, .json, .time and .load. Beside it, lane GZ-FOUNDATION's ~/.cache/grizzle-release/TESTSYS/GZ-FOUNDATION/measure/overhead1.jsonl (a worker's first take of a built template, its open included, at 64 workers) and out/forms3.log (the forms at load 616 to 1,127, templates unbuilt, under a cited 240 s first-case deadline)",
	observed: "2026-11-16 10:30:19 to 10:32:41 UTC",
	environment:
		"cassowary, Ubuntu 26.04.1 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and 247 GiB, Node 26.13.1; a private family of four PostgreSQL 19rc2 members (grizzle's scripts/pg/init.sh, fsync off, on GRIZZLE_PG_CLUSTER=5967) made just before; grizzle 0baff5d6, toolchain 88d76b7 (this lane's need-open phase); load average 391 to 468 from other sessions",
	workload:
		"grizzle's template forms, test/pg/substrate/forms.test.ts (freshBase, freshInstalled, seated, rolledBack, oneOfTemplates, served), 150 cases each at full width (64 workers), every case under the runner's 60 s case deadline: first on the new family, every template unbuilt (each member's first worker builds it under its build lock while the others wait), then again with them built. A worker's readying is timed from before its first property of the module is imported to its needs open (each module's import, its import closure hashed for the template's name, the install's plan, the template's build or the wait on it, the clone pool started), so it bounds the opens from above",
	result:
		"unbuilt: 323 readyings, p50 0.6 s, p90 19.2 s, p99 32.2 s, slowest 34.7 s (oneOfTemplates; freshInstalled 33.7 s, rolledBack 32.4 s, seated 28.3 s, freshBase 13.3 s, served 4.6 s); built: 295 readyings, p50 1.0 s, p90 15.6 s, p99 20.7 s, slowest 22.9 s. No open failed; every property passed both runs (0 of 6 failed, 63 s each), where before this phase every first case of these forms was cut at 60 s at load 400 to 600. GZ-FOUNDATION's built-template first takes at load 300 to 350 reached 18.5 s; its unbuilt run at load 616 to 1,127 ended every first case within the 240 s it cited. Not measured: opens with fsync on, where a member's DROP DATABASE waits on the checkpoints it forces (RESOURCES saw clone waits to 84 s there)",
	decision:
		"300 s: 8.6 times the slowest open measured here (34.7 s at load 391 to 468), 3.3 times that open scaled to the worst load seen today (1,127, 2.6 times as loaded: about 91 s), and above the 240 s within which every first case of the unbuilt forms ended at that load. The costs are lopsided: a bound too short fails a property whose need was only slow to open, one too long only delays the report of an open that hangs, so the headroom is wide. Unmeasured gap: opens at loads past 1,127, and with fsync on",
	revalidate:
		"a template whose build takes minutes (an install of many migrations), a family with fsync on, a run whose readyings come near a minute, a property reported unopened for running past it, another machine or a PostgreSQL repin"
})

/** The longest string a `json` value holds (values.ts): printable ASCII, so a value stays readable when printed. */
export const jsonStringMax = provisional({
	value: 8,
	owner: "the choice-stream testing library (values.ts, the json generator)",
	unit: "characters",
	scope: "each string scalar of one drawn json value",
	breaks:
		"without a most, a drawn string has no end, so a json value's cases and their printed reports grow without bound",
	measure:
		"run the consumers' properties that draw json against their plants at most-lengths of 4, 8, 32 and 128, and keep the smallest that turns as many red, measuring the cases' cost beside; or, better, make it the generator's caller input, required, as `depth` is",
	origin: LIBRARY_ORIGIN,
	recorded: RECORDED
})

/** The longest key a `json` object holds (values.ts), from six letters, so keys repeat and collide. */
export const jsonKeyMax = provisional({
	value: 3,
	owner: "the choice-stream testing library (values.ts, the json generator)",
	unit: "characters",
	scope: "each key of one drawn json object",
	breaks:
		"without a most, keys have no end and almost never repeat, so the objects that collide on a key, which the generator draws on purpose, would hardly be drawn",
	measure:
		"draw json objects at most-lengths of 1, 2, 3 and 5 and measure how often two keys of one object collide; keep the length at which collisions are common without every object having one; or, better, make it the generator's caller input, required, as `depth` is",
	origin: LIBRARY_ORIGIN,
	recorded: RECORDED
})

/** The most items a `json` array, and the most keys a `json` object, holds at each level (values.ts). */
export const jsonBranchMax = provisional({
	value: 3,
	owner: "the choice-stream testing library (values.ts, the json generator)",
	unit: "items or keys",
	scope: "each array and each object of one drawn json value, at every level of its nesting",
	breaks:
		"without a most, a nested value's size grows with its width to the power of its depth, so a json value of depth two or three could hold thousands of nodes",
	measure:
		"run the consumers' properties that draw json against their plants at most-widths of 2, 3, 5 and 8, and keep the smallest that turns as many red, measuring the cases' cost beside; or, better, make it the generator's caller input, required, as `depth` is",
	origin: LIBRARY_ORIGIN,
	recorded: RECORDED
})

/** The longest key a hostile throwing getter is drawn under (lsw.ts's wild values), from the lower-case letters. */
export const lswKeyMax = provisional({
	value: 8,
	owner: "the choice-stream testing library (lsw.ts, the wild values)",
	unit: "characters",
	scope: "the key of each drawn throwing getter",
	breaks:
		"without a most, a drawn key has no end, so a wild value's cases and reports grow without bound",
	measure:
		"run the properties that draw wild values against their plants at most-lengths of 1, 4, 8 and 32, and keep the smallest that turns as many red; or, better, make it the wild values' caller input, required",
	origin: LIBRARY_ORIGIN,
	recorded: RECORDED
})

/** The Vitest timeout of every test and hook of the toolchain's own suites (each package's vitest.config.ts). */
export const suiteTimeoutMillis = provisional({
	value: 60_000,
	owner:
		"the toolchain's own suites (packages/devtools and packages/testing, their defineTestConfig timeouts)",
	unit: "milliseconds",
	scope: "each test and each hook of the dev tools' and the testing library's suites",
	breaks:
		"without a timeout a test that hangs holds its worker, and the run, until someone stops it, and the hang is never reported as the test's",
	measure:
		"time every test and hook of both suites on cassowary over several full runs at their usual width, and choose the timeout above the slowest seen, with its headroom stated; split it per suite, or per tier, if their slowest differ by much",
	origin:
		"written with the suites' configs: the testing library's in 20b4112 and the dev tools' in 5ebe0a1 (2026-11-13), with no evidence",
	recorded: RECORDED
})

/** How long the gate waits between two looks at a snapshot's lock that another run holds (devtools/bin/gate.sh). */
export const gateLockPollSeconds = provisional({
	value: 1,
	owner: "the dev tools' gate (packages/devtools/bin/gate.sh, lock)",
	unit: "seconds",
	scope: "each wait of one gate run for the run that holds its snapshot's lock",
	breaks:
		"with no wait between looks a waiting run spins a CPU for as long as the other run holds the lock, a whole `pnpm check` at the push",
	measure:
		"time how long a waiting gate takes to start after the lock is let go, on cassowary with the hooks of several lanes waiting at once, at polls of 0.1, 0.5, 1 and 2 s, and keep the longest whose delay stays a small share of the commit gate's run",
	origin: "written with the snapshot gate in e277d8d (2026-11-14), with no evidence",
	recorded: RECORDED
})

/** How long the push gate's last passing check:full counts, before the next push runs check:full again (gate.sh). */
export const gateFullCheckDays = provisional({
	value: 1,
	owner: "the dev tools' gate (packages/devtools/bin/gate.sh, the push)",
	unit: "days",
	scope: "the age of the push snapshot's last passing check:full, in a repository that has one",
	breaks:
		"without a period a stale result of the incremental typecheck's build info (TypeScript #64386 and #64591) could pass every push for ever; with none at all every push runs the gate from scratch",
	measure:
		"over a few weeks of pushes, record each check:full that failed where the incremental check before it passed, and how long the build info had then been kept; choose the period below the shortest such age",
	origin: 'Bjorn\'s decision of 2026-11-15, "once a day", written with db83729, with no evidence',
	recorded: RECORDED
})

/**
 * How much work the runner's pool puts in one message to a worker: it fills each message with cases until their
 * expected run time reaches this, so the round trip that carries them stays a small part of the work they do. Below it,
 * the pool spends its time messaging; far above it, one slow message leaves the other workers idle at a run's end.
 */
export const messageWorkMillis = measured({
	value: 12,
	owner: "the choice-stream testing library's runner (its worker pool, the work per message)",
	unit: "milliseconds of expected case run time",
	scope: "one message the runner's pool sends one worker",
	evidence:
		"packages/testing/out/message-target/rtt-20261116.txt in grizzle's TESTSYS lane CORE's toolchain clone, the uncommitted record of its round-trip probe: a one-case message from the pool to a worker and the worker's answer, timed on the pool's side",
	observed: "2026-11-16 07:32 UTC",
	environment:
		"cassowary, Ubuntu 26.04.1 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with 64 logical CPUs and 247 GiB, Node 26.13.1; load average 22 to 49 from other sessions",
	workload:
		"one-case messages round-tripped between the runner's pool and one worker, the runner at toolchain 995e385",
	result: "every round trip took 0.41 to 0.55 ms",
	decision:
		"the round trip stays under 5% of a message's work when the work is at least 20 times the slowest round trip: 0.55 ms / 0.05 is 11 ms, and 12 ms, the next whole millisecond, leaves 4.6%. Until this limit existed the pool sent each property a fair share of the queue per message, with no number",
	revalidate:
		"a Node upgrade; a different machine; a change to the message's format or the worker transport; a run whose workers sit idle at its end while one message's cases finish"
})

/**
 * How many clones of one template a worker's Database.fresh pool holds (packages/testing/src/resources/database.ts):
 * each slot clones, offers its clone to the next case, waits for that case to end, drops it and clones again, so a
 * worker holds at most this many clones of a template and the next cases' clones are made while the current one runs.
 * Fewer, and a case waits for a clone; more, and a worker holds clones no case waits for.
 */
export const freshPoolDepth = measured({
	value: 4,
	owner: "the testing library's per-case resources (resources/database.ts, Database.fresh)",
	unit: "clones of one template per worker",
	scope:
		"one worker's pool of one template's clones; every worker holds its own, so a run holds up to this many clones of a template per worker that served it",
	evidence:
		"~/.cache/grizzle-release/TESTSYS/RESOURCES/measure/pool/ on cassowary, the uncommitted record of lane RESOURCES's probe: pool.ts, which runs the library's own Database.fresh (toolchain at 15bdf33 with the resources of slice 2) in 64 fibers of one process, each with a PgCluster service of its own (its own owner session, as a runner worker has) on member index mod 4 of a private family, one case after another: take a clone (the wait timed), connect, CREATE TABLE, then INSERT and count for the case's time; depth.jsonl and depth-on.jsonl, one row per case; env-fsync-off.txt and env-fsync-on.txt; summarize.cjs, which leaves out each run's first 8 s (the pools filling) and prints throughput and the take wait's quantiles",
	observed:
		"2026-11-16 08:25:00 to 08:30:54 UTC with fsync off; 2026-11-16 08:32:55 to 08:36:26 UTC with fsync on",
	environment:
		"cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (arm64) instance with 64 logical CPUs and 247 GiB on one EBS volume, Node 26.13.1; a private family of four PostgreSQL 19rc2 members (grizzle's scripts/pg/init.sh at ac71cfbb, each sized for 16 workers) on that volume; load average 366 to 457 from other sessions during the fsync-off runs, 351 to 372 during the fsync-on ones",
	workload:
		"64 workers, one a core, each its own pool over one template (two statements: a table and its seed row, 8 MB as cloned), 40 s a run; cases of 100 ms and of 25 ms of read-write work in their clone; depths 1, 2, 3 and 4 with fsync off, the clones FILE_COPY; depths 2 and 4 with fsync on at 100 ms, the clones WAL_LOG",
	result:
		"fsync off, 100 ms cases (take wait p50 / p90 / p99, ms; share of takes that waited under 5 ms): depth 1 892 / 3,322 / 9,049, 0.00; 2 261 / 1,684 / 3,144, 0.43; 3 0 / 539 / 2,744, 0.84; 4 0 / 2 / 2,504, 0.90; 33 to 39 cases a second at every depth. 25 ms cases: depth 1 855 / 1,388 / 1,845, 0.00; 2 17 / 938 / 1,776, 0.49; 3 0 / 508 / 1,326, 0.82; 4 0 / 0 / 1,555, 0.90; 47 to 79 cases a second. fsync on, 100 ms cases: depth 2 25,737 / 47,184 / 48,789, 0.25, 3.4 cases a second; depth 4 0 / 27,444 / 84,054, 0.53, 1.7 cases a second: each DROP DATABASE waited on checkpoints it forces, which synced thousands of files on the loaded volume, so no depth hid a clone there. No errors; the cases' own run time rose with depth (more clones in flight on the cluster), not measured apart from it",
	decision:
		"4: the smallest depth at which nine takes in ten wait for no clone (p90 2 ms and 0 ms) at full width, at both case times; at 3 the p90 wait is still half a second. Each slot past it adds a clone held per worker and in flight on the cluster, and the throughput did not rise with depth: the cluster, not the pool, bounds a run's cases a second. No headroom added; 5 and above are unmeasured",
	revalidate:
		"a PostgreSQL repin; another machine or disk; a family of another size, or clusters with fsync on (the clones then WAL_LOG); a template much larger than 8 MB; cases much shorter than 25 ms; a run whose takes wait past their p90 here"
})

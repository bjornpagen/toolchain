import { Effect, FileSystem, Path, String as Str } from "effect"
import type { Loading } from "#mutate/checkout.ts"
import { type Judged, redText } from "#mutate/kills.ts"
import { type RealPath, realPathOf } from "#mutate/mutated.ts"
import { OVERRUN_FILE, type Whose } from "#mutate/overrun.fixtures.ts"
import type { MutantPool } from "#mutate/pool.ts"
import { shell } from "#mutate/processes.fixtures.ts"
import type { Red } from "#mutate/schedule.ts"
import type { Kill } from "#property.ts"
import { SILENCE_GRACE_MILLIS } from "#runner/pool.ts"

/** The file the kills mutate. */
const TARGET = "src/f.ts"

const TARGET_TEXT = "export const f = (x: number): number => x + 1\n"

/** The kills a case draws from, by what each is. */
export const KILL_NAMES = [
	"a bug",
	"no bug",
	"an original standing twice",
	"an original standing nowhere",
	"a file not in the checkout"
] as const

export type KillName = (typeof KILL_NAMES)[number]

/** Each kill a case draws from. */
export const KILLS: Readonly<Record<KillName, Kill>> = {
	"a bug": { file: TARGET, original: "x + 1", replacement: "x + 2", why: "a bug" },
	"no bug": { file: TARGET, original: "x + 1", replacement: "1 + x", why: "no bug" },
	"an original standing twice": { file: TARGET, original: "x", replacement: "y", why: "twice" },
	"an original standing nowhere": {
		file: TARGET,
		original: "x * 9",
		replacement: "x",
		why: "nowhere"
	},
	"a file not in the checkout": {
		file: "src/missing.ts",
		original: "x + 1",
		replacement: "x + 2",
		why: "missing"
	}
}

/**
 * How a property's check runs the file: in its own process, or in a child process it starts; or a check that goes red
 * with no mutant at all (a property the run cannot judge, as one whose need the run's width cannot serve).
 */
export const CHECKS = ["direct", "child", "broken"] as const

export type CheckKind = (typeof CHECKS)[number]

/** A case: the property's check, how its workers load the code, and its kills. */
export type Gate = Readonly<{
	check: CheckKind
	loading: Loading
	kills: readonly [KillName, ...ReadonlyArray<KillName>]
}>

/** The checkout: the target, a check that imports it, and one that runs it in a child process. */
const CHECKOUT: ReadonlyArray<readonly [string, string]> = [
	["package.json", `{"type":"module"}`],
	[TARGET, TARGET_TEXT],
	["src/run-f.ts", `import { f } from "./f.ts"\nconsole.log(f(1))\n`],
	["direct.ts", `import { f } from "./src/f.ts"\nconsole.log(f(1) === 2 ? "green" : "red")\n`],
	["broken.ts", `import { f } from "./src/f.ts"\nconsole.log(f(1) === 3 ? "green" : "red")\n`],
	[
		"child.ts",
		`import { spawnSync } from "node:child_process"\nconst ran = spawnSync(process.execPath, ["src/run-f.ts"], { encoding: "utf8" })\nconsole.log(ran.status === 0 && ran.stdout.trim() === "2" ? "green" : "red")\n`
	]
]

/** A judged kill, as the gate reports it. */
export const reportOf = (judged: Judged) => {
	switch (judged.verdict.kind) {
		case "killed":
			return `${judged.kill.why}: killed`
		case "survived":
			return `${judged.kill.why}: survived, ${judged.verdict.loaded ? "loaded" : "never loaded"}`
		case "stale":
			return `${judged.kill.why}: stale, found ${String(judged.verdict.stale.found)}`
		case "unjudged":
			return `${judged.kill.why}: unjudged`
	}
}

/** What the gate must say of a kill: by the count of its original in its file, and where the check runs it. */
export const expectedOf = (gate: Gate, name: KillName) => {
	const kill = KILLS[name]
	const found = kill.file === TARGET ? Str.split(kill.original)(TARGET_TEXT).length - 1 : 0
	if (found !== 1) {
		return `${kill.why}: stale, found ${String(found)}`
	}
	if (gate.check === "broken") {
		return `${kill.why}: unjudged`
	}
	const reaches = gate.check === "direct" || gate.loading === "tree"
	if (name === "a bug" && reaches) {
		return `${kill.why}: killed`
	}
	return `${kill.why}: survived, ${reaches ? "loaded" : "never loaded"}`
}

/** A checkout of CHECKOUT, committed, in a directory of the scope's. */
export const checkoutOf = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-kills-test-" })
	const directory: RealPath = yield* realPathOf(made)
	for (const [file, text] of CHECKOUT) {
		yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
		yield* fs.writeFileString(path.join(directory, file), text)
	}
	yield* shell(
		directory,
		"git init -q && git add . && git -c user.name=t -c user.email=t@t commit -qm checkout"
	)
	return directory
})

/**
 * The case deadline the overrun property's subject runs under, in milliseconds: short, so a frozen case's worker is
 * ended within it and the pool's silence grace.
 */
export const OVERRUN_DEADLINE = 2000

/** The original each kill of the overrun property's subject replaces: the subject's case, run while not loaded. */
const OVERRUN_ORIGINAL = 'load ? frozen("its own") : Effect.void'

/**
 * The kills of the overrun property's subject (overrun.fixtures.ts), by whose overrun each makes: each freezes the
 * subject's case for ever, the machine's loading the machine first.
 */
export const OVERRUN_KILLS: Readonly<Record<Whose, Kill>> = {
	"its own": {
		file: OVERRUN_FILE,
		original: OVERRUN_ORIGINAL,
		replacement: 'frozen("its own")',
		why: "its own overrun"
	},
	"the machine's": {
		file: OVERRUN_FILE,
		original: OVERRUN_ORIGINAL,
		replacement: 'frozen("the machine\'s")',
		why: "the machine's overrun"
	}
}

/** A mutant pool whose leases' workers find `env` in their environment beside their image's. */
export const withEnv = <E>(
	pool: MutantPool<E>,
	env: Readonly<Record<string, string>>
): MutantPool<E> => ({
	width: pool.width,
	lease: (image, workers, serves) =>
		pool.lease({ ...image, env: { ...image.env, ...env } }, workers, serves)
})

/**
 * How a red's worker ended, as the overrun property reads it: by its pool past its bound, with the leg of its watch
 * that fired and, a stall, its stall window; or how else the property went red.
 */
const endedOf = (red: Red): string => {
	if (red.kind === "unstarted" || red.finding.kind !== "lost") {
		return redText(red)
	}
	const by = red.finding.by
	switch (by.kind) {
		case "other":
			return `lost otherwise: ${red.finding.report}`
		case "bound":
			return by.overrun.kind === "stalled"
				? `ended by its pool, stalled over a window of ${String(by.overrun.window)} ms`
				: `ended by its pool, its ${by.overrun.kind} leg`
	}
}

/** A judged kill of the overrun property's subject: its verdict, why it is unjudged, and how its red's worker ended. */
export const overranOf = (judged: Judged): string => {
	const verdict = judged.verdict
	switch (verdict.kind) {
		case "killed":
			return `${judged.kill.why}: killed, ${endedOf(verdict.red)}`
		case "survived":
			return `${judged.kill.why}: survived, ${verdict.loaded ? "loaded" : "never loaded"}`
		case "stale":
			return `${judged.kill.why}: stale, found ${String(verdict.stale.found)}`
		case "unjudged":
			return `${judged.kill.why}: unjudged, ${verdict.why}, ${endedOf(verdict.red)}`
	}
}

/**
 * What the overrun property must find of the kill making `whose` overrun: its worker ended by the pool past one case's
 * deadline and the grace, a stall, and killed when the overrun is its own, unjudged when the machine's.
 */
export const overranExpected = (whose: Whose): string => {
	const ended = `ended by its pool, stalled over a window of ${String(OVERRUN_DEADLINE + SILENCE_GRACE_MILLIS)} ms`
	const why = OVERRUN_KILLS[whose].why
	switch (whose) {
		case "its own":
			return `${why}: killed, ${ended}`
		case "the machine's":
			return `${why}: unjudged, the baseline overran too, ${ended}`
	}
}

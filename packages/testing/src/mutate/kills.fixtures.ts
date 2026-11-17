import { Effect, FileSystem, Path, String as Str } from "effect"
import type { Loading } from "#mutate/checkout.ts"
import type { Judged } from "#mutate/kills.ts"
import { type RealPath, realPathOf } from "#mutate/mutated.ts"
import { shell } from "#mutate/processes.fixtures.ts"
import type { Kill } from "#property.ts"

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

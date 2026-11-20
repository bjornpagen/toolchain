import { Array as Arr, Effect, FileSystem, Path } from "effect"
import { array, boolean, constant, element, type Gen, weighted } from "#gen.ts"
import type { Counted } from "#mutate/census.ts"
import type { Loading } from "#mutate/checkout.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { shell } from "#mutate/processes.fixtures.ts"
import type { Kill } from "#property.ts"

/** The product file: one function, which a strict check pins and every bound mutant of it breaks. */
const PRODUCT = "src/f.ts"

const PRODUCT_TEXT = "export const f = (x: number): number => x + 1\n"

/** The harness file, test scope: what a check may call besides the product, which no mutant or kill of shows a catch. */
const HARNESS = "test/support/h.ts"

const HARNESS_TEXT = "export const h = (x: number): number => x * 2\n"

/** The kills a check draws from, by what each is. */
const KILL_NAMES = ["a product bug", "a product edit of nothing", "a harness bug"] as const

export type KillName = (typeof KILL_NAMES)[number]

/** Each kill a check draws from. */
export const KILLS: Readonly<Record<KillName, Kill>> = {
	"a product bug": { file: PRODUCT, original: "x + 1", replacement: "x + 2", why: "a product bug" },
	"a product edit of nothing": {
		file: PRODUCT,
		original: "x + 1",
		replacement: "1 + x",
		why: "a product edit of nothing"
	},
	"a harness bug": { file: HARNESS, original: "x * 2", replacement: "x * 3", why: "a harness bug" }
}

/**
 * How a check runs: what it asserts of the product (`f(1) === 2`, the call alone, or no call), whether it asserts the
 * harness (`h(1) === 2`), whether it runs its calls in a child process, whether it goes red with no mutant at all, its
 * kills and how many kept cases it states.
 */
export type Check = Readonly<{
	product: "strict" | "loose" | "none"
	harness: boolean
	child: boolean
	broken: boolean
	kills: ReadonlyArray<KillName>
	kept: number
}>

/** A case: its checks, each a property, and how their workers load the code. */
export type Census = Readonly<{ checks: Arr.NonEmptyReadonlyArray<Check>; loading: Loading }>

export const checkGen: Gen<Check> = (source) => ({
	product: source.draw(element(["strict", "loose", "none"] as const)),
	harness: source.draw(boolean),
	child: source.draw(boolean),
	broken: source.draw(
		weighted([
			[3, constant(false)],
			[1, constant(true)]
		])
	),
	kills: Arr.dedupe(source.draw(array(element(KILL_NAMES), { min: 0, max: 2 }))),
	kept: source.draw(element([0, 1]))
})

/** The code that runs a check's calls and prints green when every assertion holds. */
const callsOf = (check: Check) => {
	const asserted = [
		...(check.product === "strict" ? ["f(1) === 2"] : []),
		...(check.product === "loose" ? ["f(1) === 2 || true"] : []),
		...(check.harness ? ["h(1) === 2"] : []),
		...(check.broken ? ["false"] : [])
	]
	return `import { f } from "./src/f.ts"\nimport { h } from "./test/support/h.ts"\nconst held = [${Arr.join(asserted, ", ")}]\nconst ok = held.every((x) => x) && [f, h].length === 2\nconsole.log(ok ? "green" : "red")\nprocess.exitCode = ok ? 0 : 1\n`
}

/** The files of check `index`: itself, and the file its child runs when it runs one. */
const checkFiles = (check: Check, index: number): ReadonlyArray<readonly [string, string]> =>
	check.child
		? [
				[`run${String(index)}.ts`, callsOf(check)],
				[
					`check${String(index)}.ts`,
					`import { spawnSync } from "node:child_process"\nconst ran = spawnSync(process.execPath, ["run${String(index)}.ts"], { encoding: "utf8" })\nconsole.log(ran.status === 0 ? ran.stdout.trim() : "red")\nprocess.exitCode = ran.status ?? 1\n`
				]
			]
		: [[`check${String(index)}.ts`, callsOf(check)]]

/** What the census may say of a check: its standing, and for a catch, what showed it. */
export type Report = "catches by kill" | "catches by mutant" | "never-caught" | "unjudged"

/** A counted property as the census reports it: its standing, and what showed a catch. */
export const reportOf = (counted: Counted): Report => {
	const { standing } = counted
	switch (standing.kind) {
		case "catches":
			return standing.by.kind === "kill" ? "catches by kill" : "catches by mutant"
		case "never-caught":
			return "never-caught"
		case "unjudged":
			return "unjudged"
	}
}

/**
 * What the census must say of a check: unjudged when it goes red with no mutant; caught by its kill when it holds the
 * product bug and runs the product strictly where the kill reaches it (in its own process, or from a tree); else caught
 * by a mutant when it runs the product strictly where mutants reach; else unjudged when it runs the product where no
 * mutant reaches (a child process of a worker that loads it in process), whose probe survives; else never-caught. A
 * harness kill, an edit of nothing and a kept case change none of it.
 */
export const expectedOf = (census: Census, check: Check): Report => {
	if (check.broken) {
		return "unjudged"
	}
	const reaches = !check.child || census.loading === "tree"
	if (check.product === "strict" && reaches) {
		return Arr.contains(check.kills, "a product bug") ? "catches by kill" : "catches by mutant"
	}
	if (check.product !== "none" && !reaches) {
		return "unjudged"
	}
	return "never-caught"
}

/** A checkout of the product, the harness, a tsconfig typing the product, and the case's checks, committed. */
export const checkoutOf = (census: Census) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-census-test-" })
		const checkout = yield* realPathOf(made)
		const files: ReadonlyArray<readonly [string, string]> = [
			["package.json", `{"type":"module"}`],
			[
				"tsconfig.json",
				`{"compilerOptions":{"strict":true,"noEmit":true,"target":"esnext","module":"nodenext","types":[],"lib":["esnext"]},"include":["src/f.ts"]}`
			],
			[PRODUCT, PRODUCT_TEXT],
			[HARNESS, HARNESS_TEXT],
			...Arr.flatMap(census.checks, checkFiles)
		]
		for (const [file, text] of files) {
			yield* fs.makeDirectory(path.dirname(path.join(checkout, file)), { recursive: true })
			yield* fs.writeFileString(path.join(checkout, file), text)
		}
		yield* shell(
			checkout,
			"git init -q && git add . && git -c user.name=t -c user.email=t@t commit -qm c"
		)
		return checkout
	})

/**
 * What the census must say of a check run as a foreign command's module (mutate/foreign.ts): its run whole is its one
 * witness, from a worker tree, so a mutant reaches it wherever it runs the product, and it states no kill: unjudged when
 * it goes red with no mutant, caught by a mutant when it runs the product strictly, never-caught otherwise.
 */
export const expectedForeignOf = (check: Check): Report => {
	if (check.broken) {
		return "unjudged"
	}
	return check.product === "strict" ? "catches by mutant" : "never-caught"
}

/** What every check imports of the repository: the product file and the harness, each a path from the checkout. */
export const IMPORTED: ReadonlyArray<string> = [PRODUCT, HARNESS]

/** The census's sources in the checkout: the product file alone, the one TypeScript file of product source. */
export const SOURCES: ReadonlyArray<string> = [PRODUCT]

/** The files the checkout's repository holds that the census reads as product or not: the product and the harness. */
export const TRACKED: ReadonlySet<string> = new Set([PRODUCT, HARNESS])

import { Effect, Option, Result } from "effect"
import { element, finite, type FiniteSpace } from "#gen.ts"
import { killApplied } from "#mutants.ts"
import { type Kill, PropertyId } from "#property.ts"
import { closuresWeighedOf, editKeyOf, runnerRootsIn } from "#runner/affected.ts"
import { editOf } from "#runner/cache.ts"
import { treeOf } from "#runner/closure.fixtures.ts"
import { contentHashOf, repoPathOf } from "#runner/closure.ts"
import type { KeyGrounds } from "#runner/grounds.ts"

/**
 * Two runs of one kill's trial for keys.test.ts, the second after one change, each run's key made as the kill census
 * makes it (runner/affected.ts weighingOf): the runner's roots (runnerRootsIn), the closures of the property's module,
 * the runner config and the runner, and of the kill's file (closuresWeighedOf), the kill as its edit (cache.ts editOf),
 * and the key under it (editKeyOf). The repository is held in memory: the property's module, test/p.test.ts, loads
 * `#a`, which the package's imports map resolves to src/a.ts, or to src/a-custom.ts under the `custom` condition, and
 * src/f.ts too where the kill's file lies inside its closure (where it lies outside, the property runs it in a child
 * process or reads it); src/f.ts, the file the kill edits, loads src/g.ts; src/h.ts is loaded by nothing but
 * an edit that names it; the runner's entry modules, the CLI loading runner/search.ts; test.config.ts, loading
 * config/layer.ts.
 */

/** Where the kill's file lies: in the property's closure (its module imports it), or outside it. */
const PLACES = [
	"the kill's file inside the property's closure",
	"the kill's file outside it"
] as const

type Place = (typeof PLACES)[number]

/** What changes between the run that recorded the kill's red and the next: one input of the verdict, or nothing it reads. */
const CHANGES = [
	"nothing the verdict reads",
	"the property's module",
	"a module the property loads",
	"the kill's file elsewhere",
	"a module the kill's file loads",
	"the kill's replacement",
	"the runner config",
	"a module the runner config loads",
	"the runner's entry",
	"a module the runner loads",
	"the runtime",
	"the config's conditions",
	"the config's conditions, resolving every module alike",
	"a module only the kill's text loads",
	"another checkout's runner, between its runs"
] as const

type Change = (typeof CHANGES)[number]

/** The situations keys.test.ts requires: every place and every change. */
export const KEY_SITUATIONS = [...PLACES, ...CHANGES] as const

/** One case: where the kill's file lies, and what changes. */
export type KeyCase = Readonly<{ place: Place; change: Change }>

/** Every place with every change. */
export const keyCases: FiniteSpace<KeyCase> = finite((source) => ({
	place: source.draw(element(PLACES)),
	change: source.draw(element(CHANGES))
}))

/** The repository a run reads, by the path of its root. */
const REPOSITORY = "/checkout"

const MODULE = "test/p.test.ts"

const CONFIG = "test.config.ts"

/** The file the kill edits. */
const EDITED = "src/f.ts"

const EDITED_TEXT = 'import { g } from "./g.ts"\n\nexport const f = (x: number) => x === g\n'

/** The file each change edits, none for a change of no file. */
const CHANGED_FILE: Readonly<Record<Change, Option.Option<string>>> = {
	"nothing the verdict reads": Option.some("src/h.ts"),
	"the property's module": Option.some(MODULE),
	"a module the property loads": Option.some("src/a.ts"),
	"the kill's file elsewhere": Option.some(EDITED),
	"a module the kill's file loads": Option.some("src/g.ts"),
	"the kill's replacement": Option.none(),
	"the runner config": Option.some(CONFIG),
	"a module the runner config loads": Option.some("config/layer.ts"),
	"the runner's entry": Option.some("runner/cli-entry.ts"),
	"a module the runner loads": Option.some("runner/search.ts"),
	"the runtime": Option.none(),
	"the config's conditions": Option.none(),
	"the config's conditions, resolving every module alike": Option.none(),
	"a module only the kill's text loads": Option.some("src/h.ts"),
	"another checkout's runner, between its runs": Option.none()
}

/**
 * The config's conditions in a case's second run, by its change: `custom`, under which the imports map resolves `#a`
 * to another file; `other`, which no map names, so every module resolves as with none; none for every other change.
 */
const CONDITIONS: Readonly<Record<Change, ReadonlyArray<string>>> = {
	"nothing the verdict reads": [],
	"the property's module": [],
	"a module the property loads": [],
	"the kill's file elsewhere": [],
	"a module the kill's file loads": [],
	"the kill's replacement": [],
	"the runner config": [],
	"a module the runner config loads": [],
	"the runner's entry": [],
	"a module the runner loads": [],
	"the runtime": [],
	"the config's conditions": ["custom"],
	"the config's conditions, resolving every module alike": ["other"],
	"a module only the kill's text loads": [],
	"another checkout's runner, between its runs": []
}

/**
 * Whether the second run of each change may take the first's red as its own: exactly when nothing its verdict reads
 * changed, which a condition that resolves every module alike is not (runner/closure.ts: a closure names its conditions
 * only through what they resolve).
 */
const ANSWERED: Readonly<Record<Change, boolean>> = {
	"nothing the verdict reads": true,
	"the property's module": false,
	"a module the property loads": false,
	"the kill's file elsewhere": false,
	"a module the kill's file loads": false,
	"the kill's replacement": false,
	"the runner config": false,
	"a module the runner config loads": false,
	"the runner's entry": false,
	"a module the runner loads": false,
	"the runtime": false,
	"the config's conditions": false,
	"the config's conditions, resolving every module alike": true,
	"a module only the kill's text loads": false,
	"another checkout's runner, between its runs": false
}

/**
 * A run's inputs: the repository's files (the kill's file's text among them, and beside them), the runtime, the
 * config's conditions, the runner's entries and the kill.
 */
type Run = Readonly<{
	files: ReadonlyArray<readonly [path: string, text: string]>
	edited: string
	runtime: string
	conditions: ReadonlyArray<string>
	entries: ReadonlyArray<string>
	kill: Kill
}>

/** A run of a case: the first (`second` false), or the one after its change. */
const runOf = (keyCase: KeyCase, second: boolean): Run => {
	const changed = (change: Change) => second && keyCase.change === change
	const textOf = (path: string, text: string) =>
		second && Option.contains(CHANGED_FILE[keyCase.change], path) ? `${text}// changed\n` : text
	const file = (path: string, text: string) => [path, textOf(path, text)] as const
	const edited = textOf(EDITED, EDITED_TEXT)
	const foreign = keyCase.change === "another checkout's runner, between its runs"
	const runner = foreign ? "/elsewhere/runner" : `${REPOSITORY}/runner`
	const loadsNew = keyCase.change === "a module only the kill's text loads"
	return {
		files: [
			[
				"package.json",
				'{ "name": "checkout", "type": "module", "imports": { "#a": { "custom": "./src/a-custom.ts", "default": "./src/a.ts" } } }\n'
			],
			["pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"],
			file("runner/cli-entry.ts", 'import "./search.ts"\n'),
			file("runner/worker-entry.ts", "export const worker = 0\n"),
			file("runner/search.ts", "export const search = 0\n"),
			file(CONFIG, 'import "./config/layer.ts"\n'),
			file("config/layer.ts", "export const layer = 0\n"),
			file(
				MODULE,
				keyCase.place === "the kill's file inside the property's closure"
					? 'import "#a"\nimport "../src/f.ts"\n'
					: 'import "#a"\n'
			),
			file("src/a.ts", "export const a = 0\n"),
			file("src/a-custom.ts", "export const a = 1\n"),
			[EDITED, edited],
			file("src/g.ts", "export const g = 0\n"),
			file("src/h.ts", "export const h = 0\n")
		],
		edited,
		runtime: changed("the runtime") ? "v26.1.0" : "v26.0.0",
		conditions: second ? CONDITIONS[keyCase.change] : [],
		entries: [`${runner}/cli-entry.ts`, `${runner}/worker-entry.ts`],
		kill: loadsNew
			? {
					file: EDITED,
					original: 'import { g } from "./g.ts"\n\nexport const f = (x: number) => x === g',
					replacement: 'import { h } from "./h.ts"\n\nexport const f = (x: number) => x === h',
					why: "f compares with h"
				}
			: {
					file: EDITED,
					original: "x === g",
					replacement: changed("the kill's replacement") ? "x > g" : "x !== g",
					why: "f compares the other way"
				}
	}
}

/** The key a run's kill verdict is recorded and read under, as the kill census makes it; none where it keys nothing. */
const keyOf = (run: Run) =>
	Effect.gen(function* () {
		const roots = runnerRootsIn(REPOSITORY, run.entries)
		const paths = Option.all({
			module: repoPathOf(MODULE),
			config: repoPathOf(CONFIG),
			edited: repoPathOf(EDITED)
		})
		if (Result.isFailure(roots) || Option.isNone(paths)) {
			return Option.none()
		}
		const closures = yield* closuresWeighedOf({
			tree: treeOf(run.files),
			conditions: run.conditions,
			runtime: run.runtime,
			runner: [...roots.success, paths.value.config],
			modules: [paths.value.module],
			edited: [paths.value.edited]
		})
		const grounds: KeyGrounds = {
			toolchain: yield* contentHashOf(new TextEncoder().encode("the toolchain")),
			environment: yield* contentHashOf(new TextEncoder().encode("the environment"))
		}
		const edit = yield* Option.match(Result.getSuccess(killApplied(run.kill, run.edited)), {
			onNone: () => Effect.succeedNone,
			onSome: (mutated) => editOf(EDITED, run.edited, mutated)
		})
		return yield* Effect.transposeOption(
			Option.map(
				Option.all({
					searched: closures.jointOf(paths.value.module),
					edited: closures.editedOf(paths.value.edited),
					edit
				}),
				({ searched, edited, edit: one }) =>
					editKeyOf(PropertyId(`${MODULE}#p`), searched, edited, one, grounds)
			)
		)
	})

/** The keys of a case's two runs: the first's, under which its red is recorded, and the second's, which is read. */
export const keysOf = (keyCase: KeyCase) =>
	Effect.all([keyOf(runOf(keyCase, false)), keyOf(runOf(keyCase, true))])

/** Whether the second run of a case may take the first's red as its own (ANSWERED). */
export const answeredOf = (keyCase: KeyCase): boolean => ANSWERED[keyCase.change]

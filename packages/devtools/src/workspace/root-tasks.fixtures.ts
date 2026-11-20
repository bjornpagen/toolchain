import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order } from "effect"
import {
	ROOT_TASK,
	rootTaskFindings,
	TOOLCHAIN_TURBO,
	TURBO,
	TURBO_CONFIG
} from "#workspace/root-tasks.ts"

/**
 * The repositories the root-tasks property draws (root-tasks.test.ts), from a grammar of the gate's contract read over
 * the names its module exports: for each of a handful of task names, whether turbo.json defines the generic task, the
 * root task and a package's own task of that name, and what the root's script of that name runs (nothing, a command of
 * its own, or turbo); with the tasks written before or after the root's and the package's; or no turbo.json at all,
 * which the contract reads as one of no tasks, so each of its names draws none. And the lines the gate reports for one.
 */

/** What a task name is in a repository, as the property names its situations. */
export type Feature =
	| "an unregistered root script"
	| "a registered root script"
	| "a root script that runs turbo"
	| "a root script with no generic task"
	| "a generic task with no root script"
	| "a package's own task"
	| "a repository with no turbo.json"

/** The task names a repository draws: a prefix of another among them, so a key is found whole or not at all. */
const NAMES = ["typecheck", "typecheck:full", "oxlint", "check", "format"] as const

/** Commands that run no turbo, each holding a word that only looks like it. */
const OWN_COMMANDS = [
	"toolchain-typecheck --incremental false",
	"next build --turbo",
	"node scripts/turbo.ts",
	"turbopack build",
	"toolchain-oxlint oxlint.config.ts"
] as const

/** Commands that run turbo: as a word, a path's last segment, one command of several, or quoted, grouped or chained
 * without spaces. */
const TURBO_COMMANDS = [
	`${TURBO} run task --filter=//`,
	`pnpm exec ${TURBO} run task`,
	`node_modules/.bin/${TURBO} run task`,
	`${TURBO} run a; status=$?; ${TURBO} run b && exit $status`,
	`sh -c '${TURBO} run task'`,
	`(${TURBO} run task)`,
	`cd sub&&${TURBO} run task`,
	`true;${TURBO} run task|cat`,
	`${TOOLCHAIN_TURBO} run task --filter=//`,
	`${TOOLCHAIN_TURBO} run a; status=$?; node_modules/.bin/${TOOLCHAIN_TURBO} run b && exit $status`
] as const

/** What the root's script of a name runs: none, a command of its own, or turbo. */
type Script = Readonly<{ kind: "none" } | { kind: "own" | "turbo"; command: string }>

const scriptGen: Gen<Script> = (source) => {
	const kind = source.draw(element(["none", "own", "turbo"] as const))
	return kind === "none"
		? { kind }
		: kind === "own"
			? { kind, command: source.draw(element(OWN_COMMANDS)) }
			: { kind, command: source.draw(element(TURBO_COMMANDS)) }
}

/** One task name in a repository: which of its tasks turbo.json defines, and the root's script of it. */
type Task = Readonly<{
	name: string
	generic: boolean
	registered: boolean
	packageOwn: boolean
	script: Script
}>

/** A repository: one Task per name, whether it has a turbo.json, and whether that writes the root's and the packages'
 * tasks first. With no turbo.json, no Task defines a task of turbo's. */
export type Repository = Readonly<{
	tasks: ReadonlyArray<Task>
	turbo: boolean
	rootFirst: boolean
}>

export const repositories: Gen<Repository> = (source) => {
	const turbo = source.draw(boolean)
	const defined = (): boolean => turbo && source.draw(boolean)
	return {
		tasks: Arr.map(NAMES, (name) => ({
			name,
			generic: defined(),
			registered: defined(),
			packageOwn: defined(),
			script: source.draw(scriptGen)
		})),
		turbo,
		rootFirst: source.draw(boolean)
	}
}

const ROOT = "/repository"

/** The line turbo.json's first task is written on: after `{`, `$schema` and `"tasks": {`. */
const FIRST_TASK_LINE = 4

/** turbo.json's task keys in the order the repository writes them. */
const keysOf = (repository: Repository): ReadonlyArray<string> => {
	const generic = Arr.flatMap(repository.tasks, (task) => (task.generic ? [task.name] : []))
	const others = Arr.flatMap(repository.tasks, (task) => [
		...(task.registered ? [`${ROOT_TASK}${task.name}`] : []),
		...(task.packageOwn ? [`@scope/a#${task.name}`] : [])
	])
	return repository.rootFirst ? [...others, ...generic] : [...generic, ...others]
}

const manifestOf = (repository: Repository): string =>
	Arr.join(
		[
			"{",
			'\t"name": "root",',
			'\t"scripts": {',
			Arr.join(
				Arr.flatMap(repository.tasks, (task) =>
					task.script.kind === "none" ? [] : [`\t\t"${task.name}": "${task.script.command}"`]
				),
				",\n"
			),
			"\t}",
			"}"
		],
		"\n"
	)

const turboOf = (repository: Repository): string =>
	Arr.join(
		[
			"{",
			'\t"$schema": "https://turbo.build/schema.json",',
			'\t"tasks": {',
			Arr.join(
				Arr.map(keysOf(repository), (key) => `\t\t"${key}": {}`),
				",\n"
			),
			"\t}",
			"}"
		],
		"\n"
	)

/** What the gate gives a repository: the line of each finding, and whether every one is root-tasks' at turbo.json. */
export type Outcome = Readonly<{ lines: ReadonlyArray<number>; placed: boolean }>

const sortedLines = (lines: ReadonlyArray<number>): ReadonlyArray<number> =>
	Arr.sort(lines, Order.Number)

/** The gate's findings over a repository. */
export const outcomeOf = (repository: Repository) =>
	Effect.map(
		rootTaskFindings({
			root: ROOT,
			manifest: manifestOf(repository),
			turbo: repository.turbo ? Option.some(turboOf(repository)) : Option.none()
		}),
		(findings): Outcome => ({
			lines: sortedLines(Arr.map(findings, (finding) => finding.line)),
			placed: Arr.every(
				findings,
				(finding) => finding.rule === "root-tasks" && finding.file === `${ROOT}/${TURBO_CONFIG}`
			)
		})
	)

/** Whether the contract reports a task: the root's script runs a command of its own, the generic task is defined, and
 * no root task is registered. */
const reported = (task: Task): boolean =>
	task.script.kind === "own" && task.generic && !task.registered

/** What the contract gives a repository: a finding at each reported task's generic key, and every one placed. */
export const expectedOf = (repository: Repository): Outcome => {
	const keys = keysOf(repository)
	return {
		lines: sortedLines(
			Arr.flatMap(repository.tasks, (task) =>
				reported(task)
					? Option.match(
							Arr.findFirstIndex(keys, (key) => key === task.name),
							{
								onNone: () => [],
								onSome: (at) => [FIRST_TASK_LINE + at]
							}
						)
					: []
			)
		),
		placed: true
	}
}

/** One situation, as a list of it. */
const one = (feature: Feature): ReadonlyArray<Feature> => [feature]

/** The situation a task's root script puts it in, if any. */
const scriptFeatureOf = (task: Task): ReadonlyArray<Feature> =>
	task.script.kind === "none"
		? task.generic
			? one("a generic task with no root script")
			: []
		: task.script.kind === "turbo"
			? one("a root script that runs turbo")
			: !task.generic
				? one("a root script with no generic task")
				: task.registered
					? one("a registered root script")
					: one("an unregistered root script")

/** The situations a repository reaches, one or more per task name. */
export const featuresOf = (repository: Repository): ReadonlyArray<Feature> => [
	...(repository.turbo ? [] : one("a repository with no turbo.json")),
	...Arr.flatMap(repository.tasks, (task) => [
		...(task.packageOwn ? one("a package's own task") : []),
		...scriptFeatureOf(task)
	])
]

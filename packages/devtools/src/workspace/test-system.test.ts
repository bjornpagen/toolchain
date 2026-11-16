import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The test system's workspace gates (src/workspace/test-system.ts), searched over repositories drawn from a grammar of
 * their contract: files of every kind a gate reads (a plant's patch at any depth, a file under test/plants/, a
 * numbered shard of a test module, a Vitest configuration, a Vite configuration with a test block, a package manifest
 * whose scripts carry a worker flag or run plants, lefthook's configuration and a shell script whose commands carry
 * one) beside their neighbours the contract leaves alone (pnpm's dependency patches, a patch outside a plants
 * directory, a test module whose name ends in a word, a Vite configuration without a test block, a near flag, a flag in
 * a comment, a script of another name), in a repository that runs the properties pack and in one that does not. Every
 * file carries the findings the contract gives it, by rule, the properties pack's only where the repository runs it,
 * and the gates' findings over the repository must be exactly those.
 *
 * Oracle: the specification, the gates' JSDoc read over the flags, directories and scripts the module exports
 * (WORKER_FLAGS, WORKER_FLAG_PREFIXES, PLANTS_DIRECTORY, TEST_PLANTS, PLANT_SCRIPT). Features: a plant, a shard, a
 * Vitest configuration, a worker flag, a file the gates leave alone, a repository with the properties pack, a
 * repository without it.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Record, String as Str } from "effect"
import type { TestSystemRule } from "#workspace/rules.ts"
import {
	PLANT_SCRIPT,
	PLANTS_DIRECTORY,
	TEST_PLANTS,
	testSystemFindings,
	WORKER_FLAG_PREFIXES,
	WORKER_FLAGS
} from "#workspace/test-system.ts"

type Feature =
	| "a plant"
	| "a shard"
	| "a Vitest configuration"
	| "a worker flag"
	| "a file the gates leave alone"
	| "a repository with the properties pack"
	| "a repository without it"

/** The gates of the properties pack; every other gate is the core's. */
const PACKED: ReadonlyArray<TestSystemRule> = ["no-vitest-config", "no-test-shards"]

/** Findings by rule. */
type Counts = Readonly<Record<TestSystemRule, number>>

/** No findings, under every gate the roster names: a gate the roster gains is a type error here until counted. */
const NONE: Counts = {
	"no-vitest-config": 0,
	"no-plants": 0,
	"no-test-shards": 0,
	"no-worker-flags": 0
}

/** Findings by rule, each counted by `count`. */
const countsBy = (count: (rule: TestSystemRule) => number): Counts =>
	Record.map(NONE, (_, rule) => count(rule))

const one = (rule: TestSystemRule, count: number): Counts => ({ ...NONE, [rule]: count })

const summed = (counts: ReadonlyArray<Counts>): Counts =>
	countsBy((rule) => Arr.reduce(counts, 0, (total, count) => total + count[rule]))

/** One file: its path (`$` its own suffix), its text, the findings the contract gives it, and what it is. */
type File = Readonly<{ path: string; text: string; findings: Counts; kind: Feature }>

const nonEmpty = <A>(items: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> =>
	Option.getOrThrow(Option.liftPredicate(items, Arr.isReadonlyArrayNonEmpty))

/** A worker flag as a command writes it: a whole flag, with a value or not, or a word a prefix begins. */
const flagGen: Gen<string> = (source) => {
	const flag = source.draw(element(nonEmpty(WORKER_FLAGS)))
	const prefix = source.draw(element(nonEmpty(WORKER_FLAG_PREFIXES)))
	return source.draw(
		element([
			flag,
			`${flag}=1`,
			`${flag} 1`,
			prefix,
			`${prefix}=forks`,
			`${prefix}Options.threads.isolate`
		])
	)
}

/** Words no gate reads as a worker flag. */
const NEAR_FLAGS = [
	"--maxWorker",
	"--workers",
	"--reporter=dot",
	"--run",
	"x--maxWorkers",
	"--no-file"
] as const

/** A command, and whether it carries a worker flag. */
const commandGen: Gen<readonly [command: string, flagged: boolean]> = (source) =>
	source.draw(boolean)
		? [`vitest run ${source.draw(flagGen)} src`, true]
		: [`vitest run ${source.draw(element(NEAR_FLAGS))} src`, false]

const plants: Gen<File> = (source) => ({
	path: source.draw(
		element([
			`${PLANTS_DIRECTORY}/testing/x$.patch`,
			`packages/a/${PLANTS_DIRECTORY}/x$.patch`,
			`${TEST_PLANTS}pg/x$.patch`,
			`${TEST_PLANTS}unit/notes$.txt`,
			`packages/a/${TEST_PLANTS}x$.patch`
		])
	),
	text: "",
	findings: one("no-plants", 1),
	kind: "a plant"
})

const shards: Gen<File> = (source) => ({
	path: `test/oracle$-${source.draw(element(["0", "1", "15"] as const))}.test.${source.draw(element(["ts", "tsx"] as const))}`,
	text: "",
	findings: one("no-test-shards", 1),
	kind: "a shard"
})

const vitestConfigs: Gen<File> = (source) => ({
	...source.draw(
		element([
			{ path: "packages/a$/vitest.config.ts", text: "export default {}" },
			{ path: "packages/a$/vitest.config.mts", text: "export default {}" },
			{ path: "packages/a$/vitest.workspace.ts", text: "export default []" },
			{
				path: "packages/a$/vite.config.ts",
				text: 'import { defineConfig } from "vitest/config"\nexport default defineConfig({})'
			},
			{
				path: "packages/a$/vite.config.ts",
				text: "export default {\n\tplugins: [],\n\ttest: { include: [] }\n}"
			}
		] as const)
	),
	findings: one("no-vitest-config", 1),
	kind: "a Vitest configuration"
})

/** A package manifest whose scripts are drawn commands, a plants script among them or not. */
const manifests: Gen<File> = (source) => {
	const commands = source.draw(array(commandGen, { min: 1, max: 3 }))
	const planted = source.draw(boolean)
	const scripts = [
		...Arr.map(commands, ([command], at) => `\t\t"test${String(at)}": "${command}"`),
		...(planted
			? [`\t\t"${source.draw(element([PLANT_SCRIPT, `${PLANT_SCRIPT}:check`]))}": "node plants.ts"`]
			: [`\t\t"${PLANT_SCRIPT}-free": "node --maxWorkersless.ts"`])
	]
	const flagged = Arr.filter(commands, ([, flag]) => flag).length
	return {
		path: "packages/a$/package.json",
		text: `{\n\t"name": "a",\n\t"description": "runs with --maxWorkers in prose",\n\t"scripts": {\n${Arr.join(scripts, ",\n")}\n\t}\n}`,
		findings: { ...NONE, "no-worker-flags": flagged, "no-plants": planted ? 1 : 0 },
		kind: flagged > 0 ? "a worker flag" : planted ? "a plant" : "a file the gates leave alone"
	}
}

/** lefthook's configuration or a shell script: drawn commands, and a comment that names a flag. */
const scriptFiles: Gen<File> = (source) => {
	const commands = source.draw(array(commandGen, { min: 1, max: 3 }))
	const path = source.draw(
		element(["packages/a$/lefthook.yml", "scripts/run$.sh", "packages/a$/bin/test.sh"] as const)
	)
	const flagged = Arr.filter(commands, ([, flag]) => flag).length
	return {
		path,
		text: Arr.join(
			[
				`# ${source.draw(flagGen)} is never written here`,
				...Arr.map(commands, ([command]) => `\t${command}`)
			],
			"\n"
		),
		findings: one("no-worker-flags", flagged),
		kind: flagged > 0 ? "a worker flag" : "a file the gates leave alone"
	}
}

/** Files the gates leave alone. */
const alone: Gen<File> = (source) => ({
	...source.draw(
		element([
			{ path: "patches/@scope__package@1.0.0-$.patch", text: "" },
			{ path: "scripts/pg/patches/fix$.patch", text: "" },
			{ path: `${PLANTS_DIRECTORY}/notes$.md`, text: "" },
			{ path: `src/${PLANTS_DIRECTORY}$.ts`, text: "" },
			{ path: "test/plant/x$.patch", text: "" },
			{ path: "test/oracle$-v2.test.ts", text: "" },
			{ path: "test/es2015$.test.ts", text: "" },
			{ path: "test/oracle$-.test.ts", text: "" },
			{
				path: "packages/a$/vite.config.ts",
				text: "export default {\n\tplugins: [],\n\tbuild: {}\n}"
			},
			{ path: "src/vitest$.ts", text: "" }
		] as const)
	),
	findings: NONE,
	kind: "a file the gates leave alone"
})

const files: Gen<File> = weighted([
	[2, plants],
	[2, shards],
	[2, vitestConfigs],
	[2, manifests],
	[2, scriptFiles],
	[3, alone]
])

type Repository = Readonly<{ files: ReadonlyArray<File>; properties: boolean }>

const repositories: Gen<Repository> = (source) => ({
	files: Arr.map(source.draw(array(files, { min: 1, max: 6 })), (file, at) => ({
		...file,
		path: Str.replaceAll("$", String(at))(file.path)
	})),
	properties: source.draw(boolean)
})

const ROOT = "/repository"

/** The findings the gates give a repository, counted by rule. */
const countsOf = (repository: Repository): Counts => {
	const texts = new Map(Arr.map(repository.files, (file) => [file.path, file.text] as const))
	const findings = testSystemFindings(
		{
			root: ROOT,
			files: Arr.map(repository.files, (file) => file.path),
			textOf: (path) => Option.fromUndefinedOr(texts.get(path)),
			parent: Option.none(),
			lintConfig: "oxlint.config.ts",
			shapeExemptions: []
		},
		repository.properties ? ["properties"] : []
	)
	return countsBy((rule) => Arr.filter(findings, (finding) => finding.rule === rule).length)
}

/** The findings the contract gives a repository: each file's, the properties pack's only where it runs. */
const expectedOf = (repository: Repository): Counts => {
	const all = summed(Arr.map(repository.files, (file) => file.findings))
	return repository.properties
		? all
		: countsBy((rule) => (Arr.contains(PACKED, rule) ? 0 : all[rule]))
}

describe("the test system's workspace gates", () => {
	it.effect("give each repository exactly the findings its files draw", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "workspace/test-system",
					oracle: {
						kind: "specification",
						name: "the gates' stated contract over the flags, directories and scripts their module exports"
					},
					draw: drawn(repositories),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a plant",
							"a shard",
							"a Vitest configuration",
							"a worker flag",
							"a file the gates leave alone",
							"a repository with the properties pack",
							"a repository without it"
						],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(repository, c) =>
					Effect.sync(() => {
						for (const file of repository.files) {
							c.note(file.kind)
						}
						c.note(
							repository.properties
								? "a repository with the properties pack"
								: "a repository without it"
						)
						deepStrictEqual(countsOf(repository), expectedOf(repository))
					})
			)
		)
	)
})

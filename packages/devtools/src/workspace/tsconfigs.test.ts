import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The workspace gate's effect-plugin-block rule (src/workspace/tsconfigs.ts), searched over the directories of its
 * fixture workspaces: the root of each and every package under it, among them a package that declares compiler plugins
 * of its own (over the Effect-free base, and over the root's tsconfig, restating the Effect plugin), a package with no
 * tsconfig, a root that declares the Effect plugin once and one that never declares it. Every directory carries the
 * number of effect-plugin-block findings the rule gives it, one for each way the plugin block is not the root's alone
 * and none for a directory that holds it as it should, and the gate's findings over the fixture workspace, counted at
 * that directory, must be exactly that many.
 *
 * Oracle: the specification, the rule's contract as the fixture workspaces state it: the root tsconfig.json holds the
 * one Effect plugin block, every package has a tsconfig.json that declares no plugin of its own. Features: a directory
 * that holds the block as it should, a package that declares plugins, a package with no tsconfig, and a root that does
 * not declare the plugin once.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Path,
	Schema,
	String as Str
} from "effect"
import { fixtureFindings, WORKSPACE_FIXTURES as FIXTURES } from "#workspace/tsconfigs.ts"

type Feature =
	| "a directory that holds the block as it should"
	| "a package that declares plugins"
	| "a package with no tsconfig"
	| "a root that does not declare the plugin once"

/** A directory of a fixture workspace (the workspace's name, the directory relative to its root, "" for the root), the
 * effect-plugin-block findings the rule gives it, and what the directory is. */
type Directory = Readonly<{
	workspace: string
	directory: string
	findings: number
	kind: Feature
}>

const HELD = "a directory that holds the block as it should"

/** A tsconfig.json as far as the contract reads it: the plugins it declares of its own. */
const Tsconfig = Schema.fromJsonString(
	Schema.Struct({
		compilerOptions: Schema.optionalKey(
			Schema.Struct({ plugins: Schema.optionalKey(Schema.Array(Schema.Unknown)) })
		)
	})
)

const decodeTsconfig = Schema.decodeUnknownEffect(Tsconfig)

/** The directories of the fixture workspaces, each with what its tsconfig.json states of it: a root holds the block when
 * it declares one plugin, a package when it declares none, and a package without a tsconfig.json holds nothing. */
const roster = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const names = yield* fs.readDirectory(FIXTURES)
	const workspaces = Arr.filter(names, (name) => !Str.startsWith(".")(name))
	const found = yield* Effect.forEach(Arr.sort(workspaces, Str.Order), (workspace) =>
		Effect.gen(function* () {
			const root = `${FIXTURES}/${workspace}`
			const leaves = yield* fs
				.readDirectory(`${root}/packages`)
				.pipe(Effect.orElseSucceed(() => []))
			const directories = [
				"",
				...Arr.map(Arr.sort(leaves, Str.Order), (leaf) => `packages/${leaf}`)
			]
			return yield* Effect.forEach(directories, (directory) =>
				Effect.gen(function* () {
					const config = `${root}/${directory}/tsconfig.json`
					const present = yield* fs.exists(config)
					const text = present ? yield* fs.readFileString(config) : "{}"
					const decoded = yield* decodeTsconfig(text)
					const declared = decoded.compilerOptions?.plugins?.length ?? 0
					const isRoot = directory === ""
					const one: Directory =
						!isRoot && !present
							? { workspace, directory, findings: 1, kind: "a package with no tsconfig" }
							: isRoot
								? declared === 1
									? { workspace, directory, findings: 0, kind: HELD }
									: {
											workspace,
											directory,
											findings: 1,
											kind: "a root that does not declare the plugin once"
										}
								: declared > 0
									? { workspace, directory, findings: 1, kind: "a package that declares plugins" }
									: { workspace, directory, findings: 0, kind: HELD }
					return one
				})
			)
		})
	)
	return Arr.flatten(found)
})

layer(NodeServices.layer)("effect-plugin-block", (it) => {
	it.effect(
		"gives each directory of the fixture workspaces the findings its contract states",
		(ctx) =>
			Effect.gen(function* () {
				const directories = yield* roster
				if (!Arr.isReadonlyArrayNonEmpty(directories)) {
					return yield* Effect.die("the fixture workspaces hold no directory")
				}
				return yield* searched(
					ctx,
					explore(
						{
							suite: "workspace/effect-plugin-block",
							oracle: {
								kind: "specification",
								name: "the rule's contract as the fixture workspaces state it: the root holds the one Effect plugin block"
							},
							draw: drawn(element(directories)),
							literal: Formatter.format,
							coverage: required<Feature>(
								[
									"a directory that holds the block as it should",
									"a package that declares plugins",
									"a package with no tsconfig",
									"a root that does not declare the plugin once"
								],
								{ cases: 100, sense: notesOnly }
							),
							kept: [],
							runs: 100,
							shrink: completeShrink,
							steerEvery: 16,
							caseHang: Duration.minutes(1)
						},
						(one, c) =>
							Effect.gen(function* () {
								c.note(one.kind)
								const path = yield* Path.Path
								const { workspace, findings } = yield* fixtureFindings(one.workspace)
								const at = path.join(workspace.root, one.directory)
								const counted = Arr.filter(
									findings,
									(finding) =>
										finding.rule === "effect-plugin-block" && path.dirname(finding.file) === at
								).length
								deepStrictEqual(counted, one.findings)
							})
					)
				)
			})
	)
})

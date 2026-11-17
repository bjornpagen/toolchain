import { registerHooks } from "node:module"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { subset, type Gen } from "#gen.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { handedFrom, resolutionsPayload, resolveKnown } from "#runner/resolutions.ts"

/**
 * The resolutions property (resolutions.test.ts) runs a program of its own twice over a module graph it writes: once
 * handed nothing, as a run's parent starts, and once handed what the first run resolved, as a pool's worker starts. This
 * module is that program when run, and the support of the property that runs it.
 */

/**
 * The kinds of specifier the graph's entry module names, each a way Node's resolver reaches a module: a relative path
 * (to a module that names another in turn), the package's own imports map, a dependency's main export and a subpath of
 * its exports (the dependency reached through a symlink, as pnpm links one), and a builtin.
 */
export type Kind = "relative" | "imports" | "main" | "subpath" | "builtin"

const KINDS: ReadonlyArray<Kind> = ["relative", "imports", "main", "subpath", "builtin"]

/** Every non-empty set of the kinds the entry names. */
export const kindSets: Gen<ReadonlyArray<Kind>> = subset(KINDS, { min: 1, max: KINDS.length })

/** The specifier the entry names for a kind, and the name the module it reaches exports. */
const named: Readonly<Record<Kind, readonly [specifier: string, name: string]>> = {
	relative: ["./sibling.js", "sibling+leaf"],
	imports: ["#own/inner.js", "inner"],
	main: ["dep", "dep"],
	subpath: ["dep/sub", "dep/sub"],
	builtin: ["node:path", "path"]
}

/**
 * Writes the graph of `kinds` into `directory`: a package of its own (an imports map, a dependency linked from its
 * node_modules to a store, as pnpm links one) whose entry, entry.js, names one specifier of each kind and exports what
 * those modules export, joined in the kinds' order.
 */
export const graphIn = (directory: string, kinds: ReadonlyArray<Kind>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const write = (path: string, text: string) => fs.writeFileString(`${directory}/${path}`, text)
		yield* fs.makeDirectory(`${directory}/own`, { recursive: true })
		yield* fs.makeDirectory(`${directory}/store/dep`, { recursive: true })
		yield* fs.makeDirectory(`${directory}/node_modules`, { recursive: true })
		yield* fs.symlink(`${directory}/store/dep`, `${directory}/node_modules/dep`)
		yield* write(
			"package.json",
			'{ "name": "graph", "type": "module", "imports": { "#own/*": "./own/*" } }\n'
		)
		yield* write(
			"store/dep/package.json",
			'{ "name": "dep", "type": "module", "exports": { ".": "./index.js", "./sub": "./sub.js" } }\n'
		)
		yield* write("store/dep/index.js", 'export const name = "dep"\n')
		yield* write("store/dep/sub.js", 'export const name = "dep/sub"\n')
		yield* write("leaf.js", 'export const name = "leaf"\n')
		yield* write(
			"sibling.js",
			'import { name as leaf } from "./leaf.js"\nexport const name = "sibling+" + leaf\n'
		)
		yield* write("own/inner.js", 'export const name = "inner"\n')
		const imports = Arr.map(kinds, (kind, at) =>
			kind === "builtin"
				? `import { basename as m${at} } from "${named[kind][0]}"`
				: `import { name as m${at} } from "${named[kind][0]}"`
		)
		const names = Arr.map(kinds, (kind, at) =>
			kind === "builtin" ? `m${at}("/x/path")` : `m${at}`
		)
		yield* write(
			"entry.js",
			`${Arr.join(imports, "\n")}\nexport const names = [${Arr.join(names, ", ")}]\n`
		)
	})

/** What the entry of a graph of `kinds` exports: each kind's module's name, in the kinds' order. */
export const namesOf = (kinds: ReadonlyArray<Kind>): ReadonlyArray<string> =>
	Arr.map(kinds, (kind) => named[kind][1])

/**
 * What a run of the program gives back: how many resolutions it made after it installed what it was handed, how many of
 * them reached Node's resolver, and what the graph's entry exports.
 */
const Ran = Schema.Struct({
	resolved: Schema.Finite,
	byNode: Schema.Finite,
	names: Schema.Array(Schema.String)
})

/** The program's role: a run's parent, handed nothing, or a pool's worker, handed what the parent run resolved. */
export type Role = "parent" | "worker"

/** The program's path in a checkout of the testing package. */
export const resolutionsProgram = (checkout: CheckoutDir): string =>
	`${checkout}/src/runner/resolutions.fixtures.ts`

/**
 * The program run over the graph in `directory` as `role`: what it gave back, read from the file it wrote, or none when
 * it wrote nothing. A parent's run writes the payload (resolutions.ts resolutionsPayload) a worker's run is handed.
 */
export const ranAs = (program: string, directory: string, role: Role) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const ranFile = `${directory}/ran.json`
			yield* Effect.ignore(fs.remove(ranFile))
			const handle = yield* ChildProcess.make(
				process.execPath,
				[...HARDENED_FLAGS, program, directory, role],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: false }
			)
			yield* handle.exitCode
			const written = yield* Effect.orElseSucceed(fs.readFileString(ranFile), () => "")
			return Option.getSuccess(Schema.decodeResult(Schema.fromJsonString(Ran))(written))
		})
	)

/** What a graph's entry exports: what its modules export, in the kinds' order. */
const Entry = Schema.Struct({ names: Schema.Array(Schema.String) })

/**
 * The program: it counts the resolutions that reach Node's resolver (a hook installed first, so it is the last a
 * resolution reaches), installs what it was handed as a worker (the payload a parent's run wrote) and then counts
 * every resolution (a hook installed last, the first a resolution reaches), imports the graph's entry, and writes what
 * it ran, and as a parent the payload of what it resolved.
 */
const program = (directory: string, role: Role) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const payloadFile = `${directory}/payload`
		const counts = { resolved: 0, byNode: 0 }
		registerHooks({
			resolve: (specifier, context, nextResolve) => {
				counts.byNode += 1
				return nextResolve(specifier, context)
			}
		})
		if (role === "worker") {
			const nodeFs = process.getBuiltinModule("node:fs")
			const fd = nodeFs.openSync(payloadFile, "r")
			handedFrom(fd)
			nodeFs.closeSync(fd)
		}
		resolveKnown()
		registerHooks({
			resolve: (specifier, context, nextResolve) => {
				counts.resolved += 1
				return nextResolve(specifier, context)
			}
		})
		const entry = yield* Effect.promise((): Promise<unknown> => import(`${directory}/entry.js`))
		const exported = yield* Schema.decodeUnknownEffect(Entry)(entry)
		if (role === "parent") {
			yield* fs.writeFile(payloadFile, resolutionsPayload())
		}
		const ran = yield* Schema.encodeEffect(Schema.fromJsonString(Ran))({
			...counts,
			names: exported.names
		})
		yield* fs.writeFileString(`${directory}/ran.json`, ran)
	})

if (import.meta.main) {
	const [directory, role] = process.argv.slice(2)
	if (directory !== undefined && (role === "parent" || role === "worker")) {
		await Effect.runPromise(program(directory, role).pipe(Effect.provide(NodeServices.layer)))
	}
}

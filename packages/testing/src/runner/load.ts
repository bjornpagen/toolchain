import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { Family, Property, type PropertyId, PropertyId as propertyId } from "#property.ts"
import { RunnerConfig } from "#runner/config.ts"

/**
 * What the runner loads at run time, by paths it learns only then: a package's runner config and its test modules.
 * This module alone imports dynamically, and checks what it loads: a config's default export is a RunnerConfig, and
 * every export of a test module is a Property or a Family.
 */

/** A runner config or a test module that could not be loaded as one, and why. */
export class LoadFailed extends Schema.TaggedError<LoadFailed, { readonly brand: unique symbol }>()(
	"LoadFailed",
	{ path: Schema.String, message: Schema.String }
) {}

/** The file a package's runner config is in, at its root. */
const CONFIG_FILE = "test.config.ts"

/** A module's namespace, imported from its path under `root`. */
const imported = (root: string, path: string): Effect.Effect<object, LoadFailed, Path.Path> =>
	Effect.gen(function* () {
		const paths = yield* Path.Path
		const url = yield* Effect.mapError(paths.toFileUrl(paths.join(root, path)), (bad) =>
			LoadFailed.make({ path, message: `${path} has no file URL: ${bad.message}` })
		)
		const namespace = yield* Effect.tryPromise({
			try: (): Promise<unknown> => import(url.href),
			catch: (cause) => LoadFailed.make({ path, message: `${path} did not load: ${String(cause)}` })
		})
		return yield* Effect.filterOrFail(
			Effect.succeed(namespace),
			(loaded): loaded is object => typeof loaded === "object" && loaded !== null,
			() => LoadFailed.make({ path, message: `${path} has no module namespace` })
		)
	})

/** A module's named exports, by name, in their order. */
const exportsOf = (namespace: object): ReadonlyArray<readonly [string, unknown]> =>
	Arr.flatMap(Reflect.ownKeys(namespace), (key) => {
		if (typeof key !== "string") {
			return []
		}
		const value: unknown = Reflect.get(namespace, key)
		return [[key, value] as const]
	})

/** The runner config of the package at `root`: its test.config.ts's default export. */
export const configOf = (root: string): Effect.Effect<RunnerConfig, LoadFailed, Path.Path> =>
	Effect.flatMap(imported(root, CONFIG_FILE), (namespace) => {
		const config: unknown = Reflect.get(namespace, "default")
		return config instanceof RunnerConfig
			? Effect.succeed(config)
			: Effect.fail(
					LoadFailed.make({
						path: CONFIG_FILE,
						message: `${CONFIG_FILE} must export defineRunner({ include, conditions, layer }) as its default`
					})
				)
	})

/** One property a test module exports: its identity, its module's path from the package root, and the property. */
export type Discovered = Readonly<{ id: PropertyId; module: string; property: Property }>

/**
 * The properties of one test module, each export a Property or a Family, a family's members each its own property
 * (`<export>/<key>`). Any other export fails the load, naming it: a test module is properties and nothing else.
 */
const propertiesOf = (
	path: string,
	namespace: object
): Effect.Effect<ReadonlyArray<Discovered>, LoadFailed> =>
	Effect.forEach(exportsOf(namespace), ([name, value]) => {
		if (value instanceof Property) {
			return Effect.succeed([{ id: propertyId(`${path}#${name}`), module: path, property: value }])
		}
		if (value instanceof Family) {
			return Effect.succeed(
				Arr.map(Rec.toEntries(value.members), ([key, member]) => ({
					id: propertyId(`${path}#${name}/${key}`),
					module: path,
					property: member
				}))
			)
		}
		return Effect.fail(
			LoadFailed.make({
				path,
				message: `${path}#${name} is neither a Property nor a Family: a test module exports properties alone (property.explore, property.exhaust, property.batched, property.interleave, property.stateful, family)`
			})
		)
	}).pipe(Effect.map(Arr.flatten))

/** Whether one path segment matches one glob segment, whose `*` stands for any run of characters. */
const segmentMatches = (pattern: string, segment: string): boolean => {
	const pieces = Str.split(pattern, "*")
	const first = Arr.headNonEmpty(pieces)
	const last = Arr.lastNonEmpty(pieces)
	if (pieces.length === 1) {
		return pattern === segment
	}
	if (
		!Str.startsWith(first)(segment) ||
		!Str.endsWith(last)(segment) ||
		first.length + last.length > segment.length
	) {
		return false
	}
	let rest = Str.slice(first.length, segment.length - last.length)(segment)
	for (const piece of Arr.drop(Arr.dropRight(pieces, 1), 1)) {
		const found = Str.indexOf(piece)(rest)
		if (Option.isNone(found)) {
			return false
		}
		rest = Str.slice(found.value + piece.length)(rest)
	}
	return true
}

/** Whether path segments match glob segments, `**` standing for any number of segments, none included. */
const globMatches = (pattern: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean =>
	Option.match(Arr.head(pattern), {
		onNone: () => path.length === 0,
		onSome: (first) =>
			first === "**"
				? globMatches(Arr.drop(pattern, 1), path) ||
					(path.length > 0 && globMatches(pattern, Arr.drop(path, 1)))
				: Option.match(Arr.head(path), {
						onNone: () => false,
						onSome: (segment) =>
							segmentMatches(first, segment) && globMatches(Arr.drop(pattern, 1), Arr.drop(path, 1))
					})
	})

/** The glob syntax a config's include may use: literal segments, `*` within one, and `**` across them. */
const UNSUPPORTED = ["?", "[", "]", "{", "}", "!"] as const

/**
 * The files one glob matches under `root`: the directory its literal leading segments name, walked, every file there
 * matched against the rest; nothing under a node_modules directory. A glob with syntax beyond `*` and `**` fails the
 * load, naming it, rather than match something else.
 */
const globbed = (
	root: string,
	glob: string
): Effect.Effect<ReadonlyArray<string>, LoadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (Arr.some(UNSUPPORTED, (sign) => Str.includes(sign)(glob))) {
			return yield* LoadFailed.make({
				path: CONFIG_FILE,
				message: `${CONFIG_FILE}: the include glob ${glob} uses syntax beyond * and **`
			})
		}
		const segments = Str.split(glob, "/")
		const base = Arr.takeWhile(Arr.dropRight(segments, 1), (segment) => !Str.includes("*")(segment))
		const rest = Arr.drop(segments, base.length)
		const directory = Arr.join([root, ...base], "/")
		const fs = yield* FileSystem.FileSystem
		const exists = yield* Effect.mapError(fs.exists(directory), (failed) =>
			LoadFailed.make({
				path: directory,
				message: `${directory} could not be read: ${failed.message}`
			})
		)
		if (!exists) {
			return []
		}
		const entries = yield* Effect.mapError(
			fs.readDirectory(directory, { recursive: true }),
			(failed) =>
				LoadFailed.make({
					path: directory,
					message: `${directory} could not be read: ${failed.message}`
				})
		)
		return Arr.flatMap(entries, (entry) => {
			const relative = Str.split(Str.replaceAll("\\", "/")(entry), "/")
			return !Arr.contains(relative, "node_modules") && globMatches(rest, relative)
				? [Arr.join([...base, ...relative], "/")]
				: []
		})
	})

/** The files these globs (a config's include or smallStack) match under `root`, in path order. */
export const matchedBy = (
	root: string,
	globs: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>, LoadFailed, FileSystem.FileSystem> =>
	Effect.map(
		Effect.forEach(globs, (glob) => globbed(root, glob)),
		(found) => Arr.sort(Arr.dedupe(Arr.flatten(found)), Order.String)
	)

/** Every property of these test modules under `root`, in module order and then export order. */
export const discover = (
	root: string,
	modules: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<Discovered>, LoadFailed, Path.Path> =>
	Effect.map(
		Effect.forEach(modules, (path) =>
			Effect.flatMap(imported(root, path), (namespace) => propertiesOf(path, namespace))
		),
		Arr.flatten
	)

/** Where a property identity points: its module, its export, and a family's key. */
export type Pointed = Readonly<{ module: string; name: string; key: Option.Option<string> }>

/** The module, export and key an identity names, none when it is no identity. */
export const pointedOf = (id: string): Option.Option<Pointed> =>
	Option.flatMap(Str.indexOf("#")(id), (hash) => {
		const module = Str.slice(0, hash)(id)
		const rest = Str.slice(hash + 1)(id)
		return Str.isNonEmpty(module) && Str.isNonEmpty(rest)
			? Option.some(
					Option.match(Str.indexOf("/")(rest), {
						onNone: () => ({ module, name: rest, key: Option.none() }),
						onSome: (slash) => ({
							module,
							name: Str.slice(0, slash)(rest),
							key: Option.some(Str.slice(slash + 1)(rest))
						})
					})
				)
			: Option.none()
	})

/** The property an identity names, loaded from its module under `root`. */
export const propertyAt = (
	root: string,
	id: string
): Effect.Effect<Property, LoadFailed, Path.Path> =>
	Option.match(pointedOf(id), {
		onNone: () =>
			Effect.fail(
				LoadFailed.make({
					path: id,
					message: `${id} is no property identity: <module>#<export>[/<key>]`
				})
			),
		onSome: (pointed) =>
			Effect.flatMap(imported(root, pointed.module), (namespace) => {
				const value: unknown = Reflect.get(namespace, pointed.name)
				const member: unknown = Option.match(pointed.key, {
					onNone: () => value,
					onSome: (key) => (value instanceof Family ? value.members[key] : undefined)
				})
				return member instanceof Property
					? Effect.succeed(member)
					: Effect.fail(
							LoadFailed.make({ path: pointed.module, message: `${id} names no property` })
						)
			})
	})

/** One value a kept regression holds, as a value file states it: the value, why it is kept, and since when. */
const KeptValue = Schema.Struct({
	value: Schema.Unknown,
	reason: Schema.String,
	since: Schema.String.check(Schema.isPattern(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")))
})

/** The kept values a value file states: its default export, an array of { value, reason, since }. */
const KeptValues = Schema.Array(KeptValue)

export type KeptValue = typeof KeptValue.Type

/**
 * The kept values of a value file (a module under `root` whose default export is an array of { value, reason, since }),
 * which `toolchain-test keep` turns into replay tokens.
 */
export const keptValuesAt = (
	root: string,
	path: string
): Effect.Effect<ReadonlyArray<KeptValue>, LoadFailed, Path.Path> =>
	Effect.flatMap(imported(root, path), (namespace) =>
		Effect.mapError(
			Schema.decodeUnknownEffect(KeptValues)(Reflect.get(namespace, "default")),
			(wrong) =>
				LoadFailed.make({
					path,
					message: `${path} must export as its default an array of { value, reason, since: "YYYY-MM-DD" }: ${wrong.message}`
				})
		)
	)

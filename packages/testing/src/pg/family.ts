import { regex } from "arkregex"
import {
	Array as Arr,
	Brand,
	Config,
	Effect,
	FileSystem,
	Option,
	Order,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ClusterFailed, failed, type Step } from "#pg/server.ts"
import { type LocalCluster, UnitName } from "#pg/spec.ts"

/**
 * A repository's cluster at one checkout: its family. Every run of a checkout, and every command and script run from
 * it, reaches the checkout's own family, `<unit>-<key>` (familyOf), and no other checkout's: trunk's worktree has one,
 * and each lane's workspace another. So the workers one member serves are its own run's, as its spec sizes them, never
 * those of every run on the machine at once (2026-11-22: trunk's 32-worker pg tier and every lane's run on grizzle's
 * one family, 54 to 75% of its busy backends waiting on SSI's cluster-wide LWLocks). A family lives as long as its
 * checkout, its templates kept between the checkout's runs, and goes with it (familiesCollected).
 */

/**
 * The real path of the package root whose family a process reaches (a lane's workspace, trunk's worktree): a run's, a
 * command's and a script's. Read once at a process's boundary (checkoutHere) and taken by everything after it.
 */
export type Checkout = string & Brand.Brand<"Checkout">

const checkoutOf = Brand.nominal<Checkout>()

/**
 * The variable that names the checkout a process reaches the family of, where its working directory is not that
 * checkout: toolchain-test gives it the workers it forks in a mutant's worker tree (runner/lease.ts), so they reach the
 * family of the checkout the tree was made from.
 */
export const checkoutVariable = "TOOLCHAIN_PG_CHECKOUT"

/**
 * The checkout this process reaches the family of (Checkout): the real path `checkoutVariable` names when it is set, and
 * by default the real path of the working directory, the package root every toolchain command and every run's worker
 * runs from. Its process's boundary reads it once (toolchain-pg's main, PgCluster.layer).
 */
export const checkoutHere: Effect.Effect<Checkout, ClusterFailed, FileSystem.FileSystem> =
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const named = yield* Effect.orDie(Config.option(Config.String(checkoutVariable)))
		const path = Option.getOrElse(named, () => ".")
		return yield* Effect.mapBoth(fs.realPath(path), {
			onFailure: (error) =>
				ClusterFailed.make({
					cluster: checkoutVariable,
					message: `the checkout ${path}: ${error.message}`
				}),
			onSuccess: checkoutOf
		})
	})

/** A checkout's real path, as a test names one it made. */
export const checkoutAt = (path: string): Checkout => checkoutOf(path)

/**
 * Where families live: `states`, a directory a family (its owner's password, hba file, unrelated CA and the checkout it
 * records) beside the directory of port claims (claimsDirectory); and `data`, the workbench's postgres@ units' data, a
 * directory a member. Read once at a process's boundary (homesHere); a test gives its own.
 */
export type Homes = Readonly<{ states: string; data: string }>

/**
 * The homes of this account (Homes): states `${XDG_STATE_HOME:-~/.local/state}/toolchain-pg`, and data
 * `~/.local/var/postgres`, where the workbench's postgres@ template keeps each member's.
 */
export const homesHere: Effect.Effect<Homes, ClusterFailed> = Effect.mapError(
	Effect.gen(function* () {
		const home = yield* Config.String("HOME")
		const base = yield* Config.withDefault(Config.String("XDG_STATE_HOME"), `${home}/.local/state`)
		return { states: `${base}/toolchain-pg`, data: `${home}/.local/var/postgres` }
	}),
	() =>
		ClusterFailed.make({
			cluster: "HOME",
			message: "HOME is unset: every family's state and data are under it"
		})
)

/** A checkout's family of a cluster: the cluster's spec, the checkout, its name (familyOf) and its homes. */
export type CheckoutFamily = Readonly<{
	cluster: LocalCluster
	checkout: Checkout
	name: UnitName
	homes: Homes
}>

/**
 * The digits of a checkout's key: the first of its path's SHA-256, as hexadecimal.
 *
 * @formatConstant a family's key: 8 hexadecimal digits, 32 bits, so two checkouts of one repository share a family
 * only by a collision of their paths' digests; with the spec's unit (spec.ts specUnitPattern, 36 characters at most)
 * and a member's `-<index>`, a member's unit name stays a UnitName
 */
const keyDigits = 8

/** A family's name after its cluster's unit and a hyphen: its key's 8 hexadecimal digits (keyDigits). */
const familyKey = regex("^[0-9a-f]{8}$")

/** `cluster`'s family at `checkout`: named `<unit>-<the first 8 hex digits of the checkout's SHA-256>`. */
export const familyOf = (
	cluster: LocalCluster,
	checkout: Checkout,
	homes: Homes
): CheckoutFamily => {
	const digest = process
		.getBuiltinModule("node:crypto")
		.createHash("sha256")
		.update(checkout)
		.digest("hex")
	return {
		cluster,
		checkout,
		name: UnitName(`${cluster.unit}-${Str.slice(0, keyDigits)(digest)}`),
		homes
	}
}

/** The family's members' unit instance names, `<family>-<index>` for each of `count`. */
export const memberNamesOf = (
	family: CheckoutFamily,
	count: number
): Arr.NonEmptyReadonlyArray<string> =>
	Arr.prepend(
		Array.from({ length: Math.max(0, count - 1) }, (_, at) => `${family.name}-${at + 1}`),
		`${family.name}-0`
	)

/** A member's unit, as systemctl names it. */
export const unitOf = (name: string): string => `postgres@${name}.service`

/**
 * The name of the directory of port claims in the states home: a file a claimed port, `<port>`, holding the family that
 * claimed it. No family's name is it (UnitName: a family's has a hyphen).
 */
const claimsDirectory = "ports"

/** The file in a family's state that names its checkout, read by collection. */
const checkoutFile = "checkout"

/** A family's state directory: `<states>/<family>`. */
export const stateOf = (family: CheckoutFamily): string => `${family.homes.states}/${family.name}`

/**
 * The checkout `family` records, in its state directory (made if absent), written by settle so collection can tell when
 * it is gone (familiesCollected).
 */
export const checkoutRecorded = (family: CheckoutFamily, step: Step) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const state = stateOf(family)
		yield* Effect.mapError(
			Effect.andThen(
				fs.makeDirectory(state, { recursive: true }),
				fs.writeFileString(`${state}/${checkoutFile}`, `${family.checkout}\n`)
			),
			(error) => failed(step, `${state}/${checkoutFile}: ${error.message}`)
		)
	})

/** A port claim's file name: the port, in decimal. */
const claimName = regex("^[0-9]{1,5}$")

/** A member's index after its family's name and a hyphen, in decimal. */
const memberIndex = regex("^[0-9]+$")

/** The ports `name` claims now in `homes`, ascending: every claim file holding its name. */
const claimsOf = (homes: Homes, name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = `${homes.states}/${claimsDirectory}`
		const files = yield* Effect.orElseSucceed(
			fs.readDirectory(directory),
			(): ReadonlyArray<string> => []
		)
		const held = yield* Effect.forEach(
			Arr.filter(files, (file) => claimName.test(file)),
			(file) =>
				Effect.map(
					Effect.orElseSucceed(fs.readFileString(`${directory}/${file}`), () => ""),
					(text) => (Str.trim(text) === name ? Option.some(Number(file)) : Option.none<number>())
				)
		)
		return Arr.sort(Arr.getSomes(held), Order.Number)
	})

/** Node's sockets. */
const net = process.getBuiltinModule("node:net")

/** Node's paths, which a `.git` file's relative git directory is resolved by. */
const paths = process.getBuiltinModule("node:path")

/** The addresses a member's TLS listener binds when it listens at localhost: IPv4's and IPv6's loopback. */
const loopbacks = ["127.0.0.1", "::1"] as const

/** Whether nothing listens at `port` on `host` now: a listener of ours binds it, and is closed. */
const freeAt = (port: number, host: string) =>
	Effect.callback<boolean>((resume) => {
		const server = net.createServer()
		server.once("error", () => resume(Effect.succeed(false)))
		server.listen({ port, host, exclusive: true }, () => {
			server.close(() => resume(Effect.succeed(true)))
		})
	})

/**
 * The most a TCP port can be.
 *
 * @formatConstant a TCP port: 16 bits, 1 to 65,535
 */
const portMax = 65_535

/**
 * A port `name` claims in `homes`, the lowest from `from` that no family claims and nothing listens at on either
 * loopback: its claim file (`<states>/ports/<port>`, holding the family's name) created only where none is (O_EXCL,
 * flag `wx`), so of two families claiming at once one takes each port and the other goes on to the next. A claim is no
 * lock: nothing waits on one, and it is removed with its family (familyRemoved).
 */
const claimed = (
	homes: Homes,
	name: string,
	from: number,
	step: Step
): Effect.Effect<number, ClusterFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = `${homes.states}/${claimsDirectory}`
		yield* Effect.mapError(fs.makeDirectory(directory, { recursive: true }), (error) =>
			failed(step, `${directory}: ${error.message}`)
		)
		for (let port = from; port <= portMax; port++) {
			const claimedBefore = yield* Effect.orElseSucceed(
				fs.exists(`${directory}/${port}`),
				() => true
			)
			if (claimedBefore) {
				continue
			}
			const free = yield* Effect.forEach(loopbacks, (host) => freeAt(port, host))
			if (!Arr.every(free, Boolean)) {
				continue
			}
			const took = yield* Effect.isSuccess(
				fs.writeFileString(`${directory}/${port}`, `${name}\n`, { flag: "wx" })
			)
			if (took) {
				return port
			}
		}
		return yield* failed(step, `no port from ${from} to ${portMax} is free to claim`)
	})

/**
 * The ports of `family`'s `count` members, member i's the i-th: the ports it claims (claimsOf), and as many more claimed
 * as it lacks (claimed), each from `from`, the spec's first port.
 */
export const portsClaimed = (family: CheckoutFamily, count: number, from: number, step: Step) =>
	Effect.gen(function* () {
		const held = yield* claimsOf(family.homes, family.name)
		const more = yield* Effect.forEach(
			Array.from({ length: Math.max(0, count - held.length) }),
			() => claimed(family.homes, family.name, from, step),
			{ concurrency: 1 }
		)
		return Arr.take([...held, ...more], count)
	})

/** The ports `family` claims now, member i's the i-th: what a run reads, claiming nothing. */
export const portsHeld = (family: CheckoutFamily) => claimsOf(family.homes, family.name)

/** A `.git` file's line naming its git directory: `gitdir: <path>`, the path relative to the file's folder or absolute. */
const gitdirLine = regex("^gitdir:\\s*")

/**
 * Whether `checkout` is a checkout still: its directory exists and, where the nearest `.git` at or above it is a file (a
 * git worktree's, as jj's colocated workspaces and trunk's worktrees are), the git directory it names exists. `jj
 * workspace forget` and `git worktree prune` remove that directory and leave the folder, so a forgotten workspace whose
 * folder lingers is no checkout, without running jj or git. A checkout under no `.git` is one while it exists.
 */
const checkoutLive = (checkout: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const exists = (path: string) => Effect.orElseSucceed(fs.exists(path), () => false)
		if (!(yield* exists(checkout))) {
			return false
		}
		let at = checkout
		for (;;) {
			const dotGit = `${at}/.git`
			const stat = yield* Effect.option(fs.stat(dotGit))
			if (Option.isSome(stat)) {
				if (stat.value.type !== "File") {
					return true
				}
				const text = yield* Effect.orElseSucceed(fs.readFileString(dotGit), () => "")
				const named = Str.trim(Str.replace(gitdirLine, "")(Str.trim(text)))
				return Str.isNonEmpty(named) && (yield* exists(paths.resolve(at, named)))
			}
			const up = paths.dirname(at)
			if (up === at) {
				return true
			}
			at = up
		}
	})

/** The checkout a family's state records, if it records one (a state of a family this module made). */
const recordedCheckout = (state: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.orElseSucceed(
			Effect.map(fs.readFileString(`${state}/${checkoutFile}`), (text) =>
				Option.some(Str.trim(text))
			),
			() => Option.none<string>()
		)
	)

/**
 * Everything of the family `name` in `homes` gone: its members' units stopped (`postgres@<name>-*`, systemctl's pattern
 * over the units it has loaded) and their failures forgotten, each member's data directory (`<data>/<name>-<i>`), its
 * port claims (only the files holding its name) and its state directory removed. What is already gone is no error.
 */
export const familyRemoved = (homes: Homes, name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		yield* Effect.forEach(
			["stop", "reset-failed"],
			(verb) =>
				Effect.ignore(
					spawner.exitCode(ChildProcess.make("systemctl", ["--user", verb, unitOf(`${name}-*`)]))
				),
			{ discard: true }
		)
		const entries = yield* Effect.orElseSucceed(
			fs.readDirectory(homes.data),
			(): ReadonlyArray<string> => []
		)
		const members = Arr.filter(
			entries,
			(entry) =>
				Str.startsWith(`${name}-`)(entry) && memberIndex.test(Str.slice(name.length + 1)(entry))
		)
		yield* Effect.forEach(
			members,
			(member) => Effect.ignore(fs.remove(`${homes.data}/${member}`, { recursive: true })),
			{ discard: true }
		)
		const ports = yield* claimsOf(homes, name)
		yield* Effect.forEach(
			ports,
			(port) => Effect.ignore(fs.remove(`${homes.states}/${claimsDirectory}/${port}`)),
			{ discard: true }
		)
		yield* Effect.ignore(fs.remove(`${homes.states}/${name}`, { recursive: true }))
	})

/**
 * Every family of the cluster `unit` in `homes` (a state named `<unit>-<8 hex digits>`, familyOf's) whose recorded
 * checkout is no checkout now (checkoutLive: its folder deleted, or a workspace forgotten whose folder lingers) removed
 * (familyRemoved): no run reaches it again, and each member holds its shared memory while it runs. Only the settling
 * repository's own families are read; a state that records no checkout (a cluster of before families, another unit's)
 * is never touched. Returns the names removed.
 */
export const familiesCollected = (
	homes: Homes,
	unit: UnitName
): Effect.Effect<
	ReadonlyArray<string>,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* Effect.orElseSucceed(
			fs.readDirectory(homes.states),
			(): ReadonlyArray<string> => []
		)
		const families = Arr.filter(
			entries,
			(name) => Str.startsWith(`${unit}-`)(name) && familyKey.test(Str.slice(unit.length + 1)(name))
		)
		const gone = yield* Effect.filter(families, (name) =>
			Effect.flatMap(recordedCheckout(`${homes.states}/${name}`), (recorded) =>
				Option.match(recorded, {
					onNone: () => Effect.succeed(false),
					onSome: (checkout) => Effect.map(checkoutLive(checkout), (live) => !live)
				})
			)
		)
		yield* Effect.forEach(gone, (name) => familyRemoved(homes, name), { discard: true })
		return gone
	})

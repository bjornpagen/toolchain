import { regex } from "arkregex"
import {
	Array as Arr,
	Brand,
	Config,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ClusterFailed, failed, type Step, succeeded } from "#pg/server.ts"
import { membersOf } from "#pg/settings.ts"
import { type LocalCluster, UnitName } from "#pg/spec.ts"

/**
 * A repository's cluster at one checkout: its family. Every run of a checkout, and every command and script run from
 * it, reaches the checkout's own family, `<unit>-<key>` (familyOf), and no other checkout's: trunk's worktree has one,
 * and each lane's workspace another. So the workers one member serves are its own run's, as its spec sizes them, never
 * those of every run on the machine at once (2026-11-22: trunk's 32-worker pg tier and every lane's run on grizzle's
 * one family, 54 to 75% of its busy backends waiting on SSI's cluster-wide LWLocks). A family's state lives as long as
 * its checkout and goes with it (familiesCollected); its members' data lives as long as their units run, its templates
 * kept between the checkout's runs while it does. A member in memory (a pattern of ~/.config/postgres/memory matching
 * its name) runs with its spec or holds no memory: the workbench's postgres@ unit removes its data as it stops, but not
 * as it restarts, and refuses to start it bare, without the spec that went with its files
 * (~/Documents/beefy-workspace/workbench/parts/postgres/files/postgres-cluster); the next settle makes it again in
 * seconds (settle.ts freedForgotten).
 */

/**
 * The real path of the checkout whose family a process reaches (a lane's workspace, trunk's worktree): its workspace's
 * root, which every package of it shares (checkoutOfPath), so a run, a command and a script of any package of one
 * checkout reach one family. Read once at a process's boundary (checkoutHere) and taken by everything after it.
 */
export type Checkout = string & Brand.Brand<"Checkout">

const checkoutOf = Brand.nominal<Checkout>()

/** Node's paths, which a checkout's parents and a `.git` file's relative git directory are resolved by. */
const paths = process.getBuiltinModule("node:path")

/**
 * The variable that names the checkout a process reaches the family of, where its working directory is not that
 * checkout: toolchain-test gives it the workers it forks in a mutant's worker tree (runner/lease.ts), so they reach the
 * family of the checkout the tree was made from.
 */
export const checkoutVariable = "TOOLCHAIN_PG_CHECKOUT"

/** The file that marks a pnpm workspace's root, which every package of the workspace lies under. */
const workspaceMarker = "pnpm-workspace.yaml"

/** The entry that marks a repository's root: git's directory, or the file a worktree's holds in its place. */
const repositoryMarker = ".git"

/** The nearest directory at or above `path` that holds an entry named `marker`, if any. */
const nearestHolding = (
	path: string,
	marker: string
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		let at = path
		for (;;) {
			if (yield* Effect.orElseSucceed(fs.exists(`${at}/${marker}`), () => false)) {
				return Option.some(at)
			}
			const up = paths.dirname(at)
			if (up === at) {
				return Option.none()
			}
			at = up
		}
	})

/**
 * The checkout the real path `path` lies in (Checkout): the nearest directory at or above it that holds
 * pnpm-workspace.yaml, its workspace's root, which every package of the workspace shares; else the nearest that holds
 * .git, its repository's root; else `path` itself. So every package of one checkout reaches one family, where each
 * package root was a checkout of its own (metis, 2026-11-23: its suites, run from packages/database, syscall-handlers
 * and syzkaller-upstream, reached three families, two never settled).
 */
export const checkoutOfPath = (
	path: string
): Effect.Effect<Checkout, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const workspace = yield* nearestHolding(path, workspaceMarker)
		if (Option.isSome(workspace)) {
			return checkoutOf(workspace.value)
		}
		const repository = yield* nearestHolding(path, repositoryMarker)
		return checkoutOf(Option.getOrElse(repository, () => path))
	})

/**
 * The checkout this process reaches the family of (Checkout): that of the real path `checkoutVariable` names when it is
 * set, and by default that of the working directory, the package root every toolchain command and every run's worker
 * runs from: its workspace's root (checkoutOfPath). Its process's boundary reads it once (toolchain-pg's main, PgCluster.layer).
 */
export const checkoutHere: Effect.Effect<Checkout, ClusterFailed, FileSystem.FileSystem> =
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const named = yield* Effect.orDie(Config.option(Config.String(checkoutVariable)))
		const path = Option.getOrElse(named, () => ".")
		const real = yield* Effect.mapError(fs.realPath(path), (error) =>
			ClusterFailed.make({
				cluster: checkoutVariable,
				message: `the checkout ${path}: ${error.message}`
			})
		)
		return yield* checkoutOfPath(real)
	})

/** A checkout's real path, as a test names one it made. */
export const checkoutAt = (path: string): Checkout => checkoutOf(path)

/**
 * Where families live: `states`, a directory a family (its owner's password, hba file, unrelated CA and the checkout it
 * records) beside the directory of port claims (claimsDirectory); and `data`, the workbench's postgres@ units' data, a
 * directory a member (for a member in memory, a link to its data in /dev/shm, which names nothing once its unit
 * stopped). Read once at a process's boundary (homesHere); a test gives its own.
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

/**
 * A checkout's family of a cluster as a process of a run of `width` workers reaches it: the cluster's spec, the
 * checkout, its name (familyOf) and its homes, and the width its state and its members are sized for, the run's
 * testWorkers (workers.ts), which its members' count and each member's share of the workers derive from (settings.ts
 * membersOf, shareOf). Its name is as its cluster's durability names it (Naming): a kept family's by its checkout
 * alone, a throwaway family's by everything its members' settings are a function of.
 */
export type CheckoutFamily = Readonly<{
	cluster: LocalCluster
	checkout: Checkout
	name: UnitName
	homes: Homes
	width: number
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

/**
 * What a family is named by, by what its cluster's data is worth (spec.ts Durability). A kept family, a person's own data,
 * by its checkout alone, the name every family had before a family was named by its settings: so a change of its
 * spec, its lock table, its sessions or its port, reaches the same member and its data, and is applied by a restart
 * (settle.ts memberSettled), where a name that held the spec opened an empty cluster at every change of a setting, its
 * data left under the old name (METIS-DBOPT, 2026-11-26: metis's development family metis-dev-5f2815d9, then 9e8880aa
 * at 4096 locks and 8b48216c at 4097). A kept cluster has no workers (spec.ts SessionsSizing), so no run's width moves
 * it. A throwaway family by everything its members' settings are a function of (settings.ts: max_connections,
 * max_wal_senders and the lock table sized by the width; the rest by the spec), so two holders of one member never
 * want it settled differently, and no settle restarts a member under another holder for its own settings: two runs of
 * one checkout at different widths shared one family, and each run's settle sized its members for its own width and
 * restarted them under the other's connections, which the server ended (57P01, STOREDERIVE4's soundness gate,
 * 2026-11-25: member 0 of STOREDERIVE4-fix's family restarted at 21:16:05 and 21:16:11Z, its connections terminated by
 * administrator command at those instants).
 */
type Naming =
	| Readonly<{ kind: "kept"; checkout: Checkout }>
	| Readonly<{ kind: "throwaway"; checkout: Checkout; width: number; cluster: LocalCluster }>

/** `cluster`'s naming at `checkout` for a run of `width` workers (Naming), by its durability. */
const namingOf = (cluster: LocalCluster, checkout: Checkout, width: number): Naming =>
	cluster.durability === "kept"
		? { kind: "kept", checkout }
		: { kind: "throwaway", checkout, width, cluster }

/** The text a family's name hashes (Naming): a kept family's checkout; a throwaway family's checkout, width and spec. */
const namedBy = (naming: Naming): string => {
	switch (naming.kind) {
		case "kept":
			return naming.checkout
		case "throwaway":
			return `${naming.checkout}\n${String(naming.width)}\n${Formatter.format(naming.cluster)}`
	}
}

/**
 * `cluster`'s family's name at `checkout` for a run of `width` workers: `<unit>-<the first 8 hex digits of the SHA-256 of
 * what it is named by (Naming)>`.
 */
const familyNameOf = (cluster: LocalCluster, checkout: Checkout, width: number): UnitName => {
	const digest = process
		.getBuiltinModule("node:crypto")
		.createHash("sha256")
		.update(namedBy(namingOf(cluster, checkout, width)))
		.digest("hex")
	return UnitName(`${cluster.unit}-${Str.slice(0, keyDigits)(digest)}`)
}

/** `cluster`'s family at `checkout` in `homes` (familyNameOf), as a run of `width` workers reaches it (CheckoutFamily). */
export const familyOf = (
	cluster: LocalCluster,
	checkout: Checkout,
	homes: Homes,
	width: number
): CheckoutFamily => ({
	cluster,
	checkout,
	name: familyNameOf(cluster, checkout, width),
	homes,
	width
})

/**
 * The names of `family`'s members, its members' unit instance names, `<family>-<i>` for each of the members its sizing
 * gives a run of its width (settings.ts membersOf).
 */
export const memberNames = (family: CheckoutFamily): Arr.NonEmptyReadonlyArray<string> => {
	const count = membersOf(family.cluster.sizing, family.width)
	return Arr.prepend(
		Array.from({ length: Math.max(0, count - 1) }, (_, at) => `${family.name}-${at + 1}`),
		`${family.name}-0`
	)
}

/** A member's unit, as systemctl names it. */
export const unitOf = (name: string): string => `postgres@${name}.service`

/**
 * The slice every unit the toolchain starts for `cluster` runs in, its repository's: the first word of its unit name
 * (`grizzle-test` in grizzle.slice), so a family's settles, holds and leases are weighed with the rest of its
 * repository's work.
 */
export const sliceOf = (cluster: LocalCluster): string =>
	`${Option.getOrElse(Arr.head(Str.split(cluster.unit, "-")), () => cluster.unit)}.slice`

/**
 * The name of the directory of port claims in the states home: a file a claimed port, `<port>`, holding the family that
 * claimed it. No family's name is it (UnitName: a family's has a hyphen).
 */
const claimsDirectory = "ports"

/** The file in a family's state that names its checkout, read by collection. */
const checkoutFile = "checkout"

/** The file in a family's state that names the width its state was settled for (widthRecorded). */
const widthFile = "width"

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

/**
 * The width `family`'s state was settled for, recorded in its state directory by settle once the ports of the members
 * that width gives are claimed (settle.ts familySettled): what a run of another width finds, and settles its own width's
 * state over (settle.ts memberBroughtUp), and what a command of no width of its own reads the family at (settle.ts
 * familyAsSettled).
 */
export const widthRecorded = (family: CheckoutFamily, step: Step) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.mapError(
			fs.writeFileString(`${stateOf(family)}/${widthFile}`, `${family.width}\n`),
			(error) => failed(step, `${stateOf(family)}/${widthFile}: ${error.message}`)
		)
	)

/** A width as a family's state records it: a whole number of workers, one at least, in decimal. */
const widthText = regex("^[1-9][0-9]*$")

/** The width `family`'s state records (widthRecorded), or none where its state records none: a family never settled. */
export const stateWidth = (family: CheckoutFamily) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.orElseSucceed(
			Effect.map(fs.readFileString(`${stateOf(family)}/${widthFile}`), (text) =>
				Option.map(
					Option.liftPredicate(Str.trim(text), (trimmed) => widthText.test(trimmed)),
					Number
				)
			),
			() => Option.none<number>()
		)
	)

/**
 * The families of `cluster` at `checkout` in `homes`, one for each width a run of the checkout settled one for: each
 * state whose recorded checkout is `checkout`, at the width it records, whose name is that width's under the cluster's
 * spec now (familyNameOf), in their states' order.
 */
export const familiesAt = (
	cluster: LocalCluster,
	checkout: Checkout,
	homes: Homes
): Effect.Effect<ReadonlyArray<CheckoutFamily>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* Effect.orElseSucceed(
			fs.readDirectory(homes.states),
			(): ReadonlyArray<string> => []
		)
		const named = Arr.filter(
			Arr.sort(entries, Order.String),
			(name) =>
				Str.startsWith(`${cluster.unit}-`)(name) &&
				familyKey.test(Str.slice(cluster.unit.length + 1)(name))
		)
		const found = yield* Effect.forEach(named, (name) =>
			Effect.gen(function* () {
				const recorded = yield* recordedCheckout(`${homes.states}/${name}`)
				if (!Option.contains(recorded, checkout)) {
					return Option.none<CheckoutFamily>()
				}
				const text = yield* Effect.orElseSucceed(
					fs.readFileString(`${homes.states}/${name}/${widthFile}`),
					() => ""
				)
				return Option.filter(
					Option.map(
						Option.liftPredicate(Str.trim(text), (trimmed) => widthText.test(trimmed)),
						(width) => familyOf(cluster, checkout, homes, Number(width))
					),
					(family) => family.name === name
				)
			})
		)
		return Arr.getSomes(found)
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

/**
 * A listener at a port, as the kernel's socket table shows it: a `process` of this account's, by its pid and the
 * systemd unit its cgroup is (a member's `postgres@<member>.service`, a run's unit, a terminal's scope); or `unseen`,
 * a listener whose process this account may not read (another account's).
 */
export type PortHolder =
	| Readonly<{ kind: "process"; pid: number; unit: string }>
	| Readonly<{ kind: "unseen" }>

/** A holder as a refusal names it. */
export const holderText = (holder: PortHolder): string =>
	holder.kind === "process"
		? `${holder.unit} (pid ${holder.pid})`
		: "a process of another account, which this one may not read"

/** A process's pid in `ss -p`'s users column: `pid=<n>`, each of a socket's processes. */
const socketPid = regex("pid=([0-9]+)", "g")

/** The systemd unit a cgroup path ends in: its last `.service` or `.scope` part. */
const unitPart = regex("\\.(service|scope)$")

/** What precedes a process's cgroup path in /proc/<pid>/cgroup: cgroup v2's hierarchy 0, with no controllers. */
const cgroupLine = regex("^0::")

/**
 * The unit of process `pid`: the last `.service` or `.scope` of its cgroup's path (/proc/<pid>/cgroup, cgroup v2's one
 * line `0::<path>`), else the path itself; none for a process gone since the socket table was read.
 */
const unitOfProcess = (pid: number) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.option(
			Effect.map(fs.readFileString(`/proc/${pid}/cgroup`), (text) => {
				const path = Str.replace(cgroupLine, "")(Str.trim(text))
				return Option.getOrElse(
					Arr.findLast(Str.split(path, "/"), (part) => unitPart.test(part)),
					() => path
				)
			})
		)
	)

/**
 * Every listener at TCP `port` on this machine now (PortHolder), read from the kernel's socket table by
 * `ss -Hltnp sport = :<port>`, which reads it and binds nothing, so a member starting at that port at that moment is
 * never refused by the reading: none where nothing listens there.
 */
export const portHolders = (
	port: number,
	step: Step
): Effect.Effect<
	ReadonlyArray<PortHolder>,
	ClusterFailed,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const listed = yield* succeeded(
			{ ...step, doing: `${step.doing}: reading who listens at its port ${port}` },
			ChildProcess.make("ss", ["-Hltnp", "sport", "=", `:${port}`])
		)
		const lines = Arr.filter(Str.split(listed, "\n"), Str.isNonEmpty)
		const held = yield* Effect.forEach(lines, (line) =>
			Arr.match(
				Arr.map(Array.from(Str.matchAll(socketPid)(line)), ([, pid]) => Number(pid)),
				{
					onEmpty: () => Effect.succeed<ReadonlyArray<PortHolder>>([{ kind: "unseen" }]),
					onNonEmpty: (pids) =>
						Effect.map(
							Effect.forEach(pids, (pid) =>
								Effect.map(unitOfProcess(pid), (unit) =>
									Option.map(unit, (named): PortHolder => ({ kind: "process", pid, unit: named }))
								)
							),
							Arr.getSomes
						)
				}
			)
		)
		return Arr.dedupeWith(Arr.flatten(held), (a, b) => holderText(a) === holderText(b))
	})

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

/** Every member directory of the family `name` in `home` (`<home>/<name>-<i>`) removed, a link as itself. */
const membersRemoved = (home: string, name: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* Effect.orElseSucceed(
			fs.readDirectory(home),
			(): ReadonlyArray<string> => []
		)
		const members = Arr.filter(
			entries,
			(entry) =>
				Str.startsWith(`${name}-`)(entry) && memberIndex.test(Str.slice(name.length + 1)(entry))
		)
		yield* Effect.forEach(
			members,
			(member) => Effect.ignore(fs.remove(`${home}/${member}`, { recursive: true })),
			{ discard: true }
		)
	})

/**
 * Everything of the family `name` in `homes` gone: its members' units stopped (`postgres@<name>-*`, systemctl's pattern
 * over the units it has loaded), which takes a member's data in memory with it, and their failures forgotten, each
 * member's data directory (`<data>/<name>-<i>`), its port claims (only the files holding its name) and its state
 * directory removed. What is already gone is no error.
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
		yield* membersRemoved(homes.data, name)
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
 * checkout is no checkout now (checkoutLive: its folder deleted, or a workspace forgotten whose folder lingers), or a
 * place inside one, which no process reaches a family at (checkoutOfPath: a package of a workspace, where a family was
 * made at each package root before checkouts were workspaces) removed (familyRemoved): no run reaches it again, and each member holds its shared memory while it runs. Only the settling
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
					onSome: (checkout) =>
						Effect.map(
							Effect.all([checkoutLive(checkout), checkoutOfPath(checkout)]),
							([live, root]) => !live || root !== checkout
						)
				})
			)
		)
		yield* Effect.forEach(gone, (name) => familyRemoved(homes, name), { discard: true })
		return gone
	})

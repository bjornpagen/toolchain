import { Array as Arr, Deferred, Effect, FileSystem, Option, Result, String as Str } from "effect"
import { type LeaseFailed, type Placement, type Reservation, reserved } from "#pg/lease.ts"

/**
 * The lease properties (lease.test.ts) hold each run's reservation until every run either holds or waits in the kernel,
 * so the runs overlap as far as the lease lets them, and read who holds a lease's files: what they read is how many
 * processes wait, blocked, on a lock file of a lease directory, and which process holds a slot or a door, as Linux lists
 * its locks (/proc/locks, a waiter's line marked `->`, each lock named by its file's device and inode).
 */

/** A device number as /proc/locks spells it: its major and minor, each in hexadecimal, two digits at least. */
const deviceText = (device: bigint): string => {
	const major = (device >> 8n) & 0xfffn
	const minor = (device & 0xffn) | ((device >> 12n) & 0xfff00n)
	return `${Str.padStart(2, "0")(major.toString(16))}:${Str.padStart(2, "0")(minor.toString(16))}`
}

/** A lock Linux lists on a file of a directory: the file's name there, the process, and whether it waits, blocked. */
type DirectoryLock = Readonly<{ name: string; pid: number; blocked: boolean }>

/**
 * The locks Linux lists now on the files of `directory` (/proc/locks: a line a lock, a waiter's marked `->` after the
 * lock's number, then the lock's class, mode and kind, the process and the file as `major:minor:inode`).
 */
const locksIn = (
	directory: string
): Effect.Effect<ReadonlyArray<DirectoryLock>, never, FileSystem.FileSystem> =>
	Effect.orDie(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const names = yield* fs.readDirectory(directory)
			const files = yield* Effect.forEach(names, (name) =>
				Effect.map(fs.stat(`${directory}/${name}`), (info) => ({ name, info }))
			)
			const named = new Map<string, string>(
				Arr.flatMap(files, ({ name, info }) =>
					Option.match(info.ino, {
						onNone: () => [],
						onSome: (inode) => [[`${deviceText(info.dev)}:${inode}`, name] as const]
					})
				)
			)
			const locks = yield* fs.readFileString("/proc/locks")
			return Arr.flatMap(Str.split("\n")(locks), (line): ReadonlyArray<DirectoryLock> => {
				const fields = Arr.filter(Str.split(" ")(line), Str.isNonEmpty)
				const blocked = Arr.contains(fields, "->")
				const rest = Arr.drop(fields, blocked ? 2 : 1)
				return Option.match(
					Option.all([
						Arr.get(rest, 3),
						Option.flatMap(Arr.get(rest, 4), (file) => Option.fromUndefinedOr(named.get(file)))
					]),
					{ onNone: () => [], onSome: ([pid, name]) => [{ name, pid: Number(pid), blocked }] }
				)
			})
		})
	)

/**
 * How many processes wait, blocked, on a lock of a file in `directory` other than a family's choose lock, which a lease
 * holds only while it looks at the slots (scripts/hold.pl): those waiting for the family's queue or a slot.
 */
export const blockedOn = (directory: string): Effect.Effect<number, never, FileSystem.FileSystem> =>
	Effect.map(
		locksIn(directory),
		(locks) => Arr.filter(locks, (lock) => lock.blocked && lock.name !== "choose.lock").length
	)

/** The processes that wait, blocked, on the lock of the file `name` in `directory`. */
export const blockedOnFile = (
	directory: string,
	name: string
): Effect.Effect<ReadonlyArray<number>, never, FileSystem.FileSystem> =>
	Effect.map(locksIn(directory), (locks) =>
		Arr.map(
			Arr.filter(locks, (lock) => lock.blocked && lock.name === name),
			(lock) => lock.pid
		)
	)

/** The process that holds the lock of the file `name` in `directory`, if one does. */
export const holderOf = (
	directory: string,
	name: string
): Effect.Effect<Option.Option<number>, never, FileSystem.FileSystem> =>
	Effect.map(locksIn(directory), (locks) =>
		Option.map(
			Arr.findFirst(locks, (lock) => !lock.blocked && lock.name === name),
			(lock) => lock.pid
		)
	)

/**
 * The slots the family's queue's holder waits for in `directory`, a lease directory, each once a child of its own waits
 * for it there (scripts/hold.pl's collector): the name of the slot's file, beside the door the queue's holder holds
 * (`<at>.door` for `<at>.lock`), the queue's holder, and its child blocked on the slot's lock.
 */
export const shieldsIn = (
	directory: string
): Effect.Effect<
	ReadonlyArray<Readonly<{ slot: string; holder: number; waiter: number }>>,
	never,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const locks = yield* locksIn(directory)
		const parents = yield* Effect.forEach(
			Arr.filter(locks, (lock) => lock.blocked),
			(lock) => Effect.map(parentOf(lock.pid), (parent) => ({ lock, parent }))
		)
		return Arr.flatMap(locks, (door) => {
			const slot = Str.replace(".door", ".lock")(door.name)
			return door.blocked || !Str.endsWith(".door")(door.name)
				? []
				: Option.toArray(
						Option.map(
							Arr.findFirst(
								parents,
								({ lock, parent }) => lock.name === slot && Option.contains(parent, door.pid)
							),
							({ lock }) => ({ slot, holder: door.pid, waiter: lock.pid })
						)
					)
		})
	})

/** The first of shieldsIn, once there is one. */
export const shieldIn = (directory: string) => Effect.map(shieldsIn(directory), Arr.head)

/** A process's parent, by its /proc/<pid>/stat (the field after its state); none for a process gone. */
const parentOf = (
	pid: number
): Effect.Effect<Option.Option<number>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const stat = yield* Effect.orElseSucceed(fs.readFileString(`/proc/${pid}/stat`), () => "")
		return Option.flatMap(Str.lastIndexOf(")")(stat), (end) =>
			Option.map(
				Arr.get(Arr.filter(Str.split(" ")(Str.slice(end + 1)(stat)), Str.isNonEmpty), 1),
				Number
			)
		)
	})

/**
 * The members of the spread-lease property's family (lease.test.ts runsLeaseTheirWork): four, as grizzle's 5442 and
 * 5491 have, each a lease directory of the case's own.
 */
export const SPREAD_MEMBERS = 4

/**
 * The slots each member of the spread-lease property's family admits: 16, as each of 5491's does (its capacity over its
 * workers' connections), so four runs of 16 workers each, spread over four members, fit at once.
 */
const SPREAD_SLOTS = 16

/**
 * A family of `members` members under `directory`, each a lease directory admitting `slots` workers of one connection,
 * its port its place from 1.
 */
export const familyIn = (directory: string, members: number, slots: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const made = yield* Effect.forEach(
			Array.from({ length: members }, (_, at) => at + 1),
			(port) =>
				Effect.gen(function* () {
					const lease = `${directory}/${port}`
					yield* fs.makeDirectory(lease, { recursive: true })
					yield* fs.writeFileString(`${lease}/capacity`, `${slots}\n`)
					return { port, lease }
				})
		)
		return yield* Option.match(Arr.head(made), {
			onNone: () => Effect.die("a family of no member"),
			onSome: (first) => Effect.succeed([first, ...Arr.drop(made, 1)] as const)
		})
	})

/** A family of SPREAD_MEMBERS members under `directory`, each a lease directory admitting SPREAD_SLOTS workers of one connection. */
export const spreadFamily = (directory: string) => familyIn(directory, SPREAD_MEMBERS, SPREAD_SLOTS)

/**
 * `reservation` held by a fiber of the enclosing scope until `release` completes, as a run holds its lease: what it
 * answers once it holds (its Placement), or its failure.
 */
export const heldUntil = (reservation: Reservation, release: Deferred.Deferred<void>) =>
	Effect.gen(function* () {
		const held = yield* Deferred.make<Placement, LeaseFailed>()
		yield* Effect.forkScoped(
			Effect.scoped(
				Effect.andThen(Deferred.into(reserved(reservation), held), Deferred.await(release))
			)
		)
		return held
	})

/** Sends `signal` to process `pid`, which may have ended: a process gone takes none. */
export const signalled = (pid: number, signal: "SIGSTOP" | "SIGCONT" | "SIGKILL") =>
	Effect.sync(() => {
		Result.try(() => process.kill(pid, signal))
	})

/**
 * Whether process `pid` is stopped now, by a signal (its /proc/<pid>/stat state `T`, the field after its command's
 * closing parenthesis): `some` once it is.
 */
export const stopped = (
	pid: number
): Effect.Effect<Option.Option<true>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const stat = yield* Effect.orElseSucceed(fs.readFileString(`/proc/${pid}/stat`), () => "")
		const state = Option.flatMap(Str.lastIndexOf(")")(stat), (end) =>
			Arr.head(Arr.filter(Str.split(" ")(Str.slice(end + 1)(stat)), Str.isNonEmpty))
		)
		return Option.contains(state, "T") ? Option.some(true as const) : Option.none()
	})

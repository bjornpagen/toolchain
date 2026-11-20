import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"

/**
 * The lease property (lease.test.ts runsWaitInLine) holds each run's reservation until every run either holds or waits
 * in the kernel, so the runs overlap as far as the lease lets them: what it reads is how many processes wait, blocked,
 * on a lock file of a lease directory, as Linux lists its locks (/proc/locks, a waiter's line marked `->`, each lock
 * named by its file's device and inode).
 */

/** A device number as /proc/locks spells it: its major and minor, each in hexadecimal, two digits at least. */
const deviceText = (device: bigint): string => {
	const major = (device >> 8n) & 0xfffn
	const minor = (device & 0xffn) | ((device >> 12n) & 0xfff00n)
	return `${Str.padStart(2, "0")(major.toString(16))}:${Str.padStart(2, "0")(minor.toString(16))}`
}

/** How many processes wait, blocked, on a lock of a file in `directory`. */
export const blockedOn = (directory: string): Effect.Effect<number, never, FileSystem.FileSystem> =>
	Effect.orDie(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const names = yield* fs.readDirectory(directory)
			const files = yield* Effect.forEach(names, (name) => fs.stat(`${directory}/${name}`))
			const named = new Set(
				Arr.flatMap(files, (info) =>
					Option.match(info.ino, {
						onNone: () => [],
						onSome: (inode) => [`${deviceText(info.dev)}:${inode}`]
					})
				)
			)
			const locks = yield* fs.readFileString("/proc/locks")
			return Arr.filter(Str.split("\n")(locks), (line) => {
				const fields = Arr.filter(Str.split(" ")(line), Str.isNonEmpty)
				return (
					Arr.contains(fields, "->") && Option.exists(Arr.get(fields, 6), (file) => named.has(file))
				)
			}).length
		})
	)

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

/** A family of SPREAD_MEMBERS members under `directory`, each a lease directory admitting SPREAD_SLOTS workers of one connection. */
export const spreadFamily = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const members = yield* Effect.forEach(
			Array.from({ length: SPREAD_MEMBERS }, (_, at) => at + 1),
			(port) =>
				Effect.gen(function* () {
					const lease = `${directory}/${port}`
					yield* fs.makeDirectory(lease, { recursive: true })
					yield* fs.writeFileString(`${lease}/capacity`, `${SPREAD_SLOTS}\n`)
					return { port, lease }
				})
		)
		return yield* Option.match(Arr.head(members), {
			onNone: () => Effect.die("the spread family has no member"),
			onSome: (first) => Effect.succeed([first, ...Arr.drop(members, 1)] as const)
		})
	})

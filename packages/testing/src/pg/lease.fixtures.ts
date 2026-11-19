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

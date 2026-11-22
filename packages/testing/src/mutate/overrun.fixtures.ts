import { Config, Effect, FileSystem } from "effect"
import { boolean, finite, type Gen, int, map } from "#gen.ts"
import { property } from "#property.ts"

/**
 * The kill gate's overrun property (kills.test.ts killOverran) judges kills of a planted subject on leases of the
 * mutator's own pool (runner/lease.ts): this module is that subject, which the leases' workers load, and the target its
 * kills mutate.
 */

/** The variable of a worker's environment naming the file whose being there says the machine is loaded. */
export const LOAD_FILE = "TOOLCHAIN_TEST_LOAD_FILE"

/** The planted subject's identity, as a lease's workers load it from the testing package's root. */
export const OVERRUNS = "src/mutate/overrun.fixtures.ts#overruns"

/** This module, as a kill names its file: from the testing package's root, the overrun property's checkout. */
export const OVERRUN_FILE = "src/mutate/overrun.fixtures.ts"

/**
 * Whose a frozen case's overrun is: its own, the mutant's; or the machine's, which then stays loaded (the load file is
 * written), so the subject's next case freezes too, as a loaded machine holds a baseline past its bound as well as a
 * mutant's trial.
 */
export type Whose = "its own" | "the machine's"

/** Both overruns, the mutant's own and the machine's. */
export const overrunSpace: Gen<Whose> = map(boolean, (machine): Whose =>
	machine ? "the machine's" : "its own"
)

/**
 * A case frozen for ever: it loads the machine first when the overrun is the machine's, then sends its process SIGSTOP,
 * which no handler catches, so every thread of the process stops, the case's own guard and the watchdog with the case,
 * and only its pool can end it.
 */
const frozen = (whose: Whose) =>
	Effect.gen(function* () {
		if (whose === "the machine's") {
			const fs = yield* FileSystem.FileSystem
			const load = yield* Config.String(LOAD_FILE)
			yield* fs.writeFileString(load, "")
		}
		process.kill(process.pid, "SIGSTOP")
	})

/** Whether the machine is loaded: the load file is there. */
const loaded = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const load = yield* Config.String(LOAD_FILE)
	return yield* fs.exists(load)
})

/**
 * The planted subject: its case passes at once while the machine is not loaded and is frozen while it is; a kill of it
 * freezes its case outright (OVERRUN_KILLS, kills.fixtures.ts).
 */
export const overruns = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () => Effect.flatMap(loaded, (load) => (load ? frozen("its own") : Effect.void)),
	oracle: {
		kind: "specification",
		name: "a subject planted to freeze its case while the machine is loaded, and under its kills"
	},
	kept: [],
	kills: []
})

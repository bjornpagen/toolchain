import { Array as Arr, Option } from "effect"
import type { Setting } from "#pg/settings.ts"

/**
 * What the predicate settings property (settings.test.ts) reads a member's settings by: a setting's value by its name,
 * and PostgreSQL 19.0's defaults of the settings that count a member's backends.
 */

/** A setting's value as an integer, by its name, among `settings`, or none. */
export const valueOf = (settings: ReadonlyArray<Setting>, name: string): Option.Option<number> =>
	Option.map(
		Arr.findFirst(settings, ([named]) => named === name),
		([, value]) => Number(value)
	)

/**
 * PostgreSQL 19.0's defaults of the settings a member's backends count, which a member leaves as they are, and its
 * special workers: autovacuum_worker_slots, max_worker_processes, max_wal_senders, the autovacuum launcher and the slot
 * sync worker (proc.h NUM_SPECIAL_WORKER_PROCS), and max_prepared_transactions.
 */
export const defaults = {
	autovacuum: 16,
	workers: 8,
	senders: 10,
	special: 2,
	prepared: 0
} as const

import { Array as Arr, Order, Record as Rec, Result } from "effect"
import { type CompileCache, compiledEnvironmentOf } from "#runner/compile-cache.ts"
import { allowanceVariable, processors } from "#workers.ts"

/**
 * The environment a run's workers are given, and nothing else of the runner's: a verdict is keyed by what its property
 * can observe (runner/cache.ts VerdictKey), and every variable a worker holds is a value it can read. So the pool gives
 * each worker the variables named here and those the runner config states (RunnerConfig's environment), as the runner's
 * own environment holds them, with the runner's plumbing on top (its CPU allowance, its compile cache, a mutant's), and
 * the verdict key holds their digest (workerEnvironmentText); a variable of a terminal, a unit or an agent's session
 * (INVOCATION_ID, PWD, JOURNAL_STREAM, TERM) never reaches a worker, so two checkouts' runs under one account key alike.
 */

/**
 * The variables of the runner's environment every worker is given, by what needs them: the account (HOME, USER,
 * LOGNAME, SHELL), where programs are (PATH), the locale and time zone (LANG, LC_ALL, TZ), the places the account's
 * tools keep their files (TMPDIR and the XDG directories), the account's systemd manager, which a cluster's holds and
 * leases ask (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS), and the clusters' certificate authority (PGSSLROOTCERT). No
 * compile cache variable is among them: a child's compile cache is the runner's to state (childEnvironmentOf), and the
 * account's switch or folder never reaches one.
 */
const WORKER_VARIABLES = [
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"LANG",
	"LC_ALL",
	"TZ",
	"TMPDIR",
	"XDG_RUNTIME_DIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"DBUS_SESSION_BUS_ADDRESS",
	"PGSSLROOTCERT"
] as const

/**
 * A worker's environment from the runner's `given` one: each of WORKER_VARIABLES and `declared` (the runner config's)
 * that it holds, as it holds it, and no other variable.
 */
export const workerEnvironmentOf = (
	declared: ReadonlyArray<string>,
	given: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> =>
	Rec.fromEntries(
		Arr.filterMap(Arr.dedupe([...WORKER_VARIABLES, ...declared]), (name) => {
			const value = given[name]
			return value === undefined ? Result.failVoid : Result.succeed([name, value] as const)
		})
	)

/**
 * A worker environment as the verdict key digests it: a line `name=value` for each variable, sorted by name, so two
 * runs key alike exactly when their workers are given the same variables with the same values.
 */
export const workerEnvironmentText = (environment: Readonly<Record<string, string>>): string =>
	Arr.join(
		Arr.map(
			Arr.sort(Rec.keys(environment), Order.String),
			(name) => `${name}=${environment[name] ?? ""}\n`
		),
		""
	)

/**
 * The environment a child of the runner's starts with, a pool's worker (runner/pool.ts) and a load's process
 * (runner/loads.ts) alike: its worker environment (workerEnvironmentOf), this process's CPU share as its allowance
 * (workers.ts allowanceVariable), so a child started late, after its cgroup's quota moved, is of the run's width still,
 * and its compile cache as the runner states it (compile-cache.ts compiledEnvironmentOf), and nothing else.
 */
export const childEnvironmentOf = (
	environment: Readonly<Record<string, string>>,
	cache: CompileCache
): Readonly<Record<string, string>> =>
	compiledEnvironmentOf({ ...environment, [allowanceVariable]: `${processors}` }, cache)

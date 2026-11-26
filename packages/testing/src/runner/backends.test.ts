/**
 * How a process tree's backends are found (runner/backends.ts), over a /proc made to stand for the machine's
 * (backends.fixtures.ts procOf): a backend's parallel workers are the case's work, another backend's are not; and the
 * kernel's socket tables are read only at a reading that meets a socket the tree opened since its last, each socket
 * classified once for its life.
 *
 * Oracles are stated per property.
 */
import { Array as Arr, Effect } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
import { property } from "#property.ts"
import {
	backendPids,
	CASE,
	FOREIGN,
	LEADER,
	machineOf,
	opens,
	procOf,
	readingsGen,
	tablesOf,
	workerPid,
	workersGen
} from "#runner/backends.fixtures.ts"
import { ledgerAt, scanned } from "#runner/backends.ts"

export const aParallelWorkerIsItsLeadersWork = property.exhaust(finite(workersGen), {
	box: "a case's backend beside none to two parallel workers under its postmaster, each the case's backend's or another backend's",
	needs: {},
	situations: ["a worker of the case's backend", "a worker of another backend"],
	check: (_, c) => (workers) =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = yield* procOf(machineOf(workers))
				const ledger = ledgerAt(root)
				yield* scanned(ledger, [CASE], Effect.succeed(tablesOf(FOREIGN)))
				if (Arr.some(workers, (forTheCase) => forTheCase)) {
					c.note("a worker of the case's backend")
				}
				if (Arr.some(workers, (forTheCase) => !forTheCase)) {
					c.note("a worker of another backend")
				}
				assert.deepEqual(
					backendPids(ledger, [CASE]),
					[LEADER, ...Arr.flatMap(workers, (forTheCase, n) => (forTheCase ? [workerPid(n)] : []))],
					"the case's backends: its backend, and each parallel worker that backend leads"
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a parallel worker is the case's work exactly when the backend its title names, `parallel worker for PID <leader>`, serves a socket of the case's tree"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/backends.ts",
			original:
				"\treturn Arr.filter([...leaders, ...workers], (backend) => !ledger.observers.has(backend.pid))\n",
			replacement:
				"\treturn Arr.filter(leaders, (backend) => !ledger.observers.has(backend.pid))\n",
			why: "A parallel worker's CPU is left out of its leader's case, so a parallel plan's workers spend nothing of its budget and a leader that waits on them reads as stalled; the worker of the case's backend goes uncounted."
		},
		{
			file: "packages/testing/src/runner/backends.ts",
			original: "\t\tleading.has(leaderKey(worker.postmaster, leader)) ? [worker] : []\n",
			replacement: "\t\t[worker]\n",
			why: "Every parallel worker of the server is counted, whoever leads it: a sibling case's parallel plan moves a hung case, so it is never judged."
		}
	]
})

export const aReadingReadsTheSocketTablesOnlyForASocketNotClassifiedYet = property.exhaust(
	finite(readingsGen),
	{
		box: "one to three readings of a case holding one server's socket, then one to three after it opens a socket to no server",
		needs: {},
		situations: [],
		check: () => (counts) =>
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* procOf(machineOf([]))
					const ledger = ledgerAt(root)
					const tables = Effect.succeed(tablesOf(FOREIGN))
					yield* Effect.forEach(
						Array.from({ length: counts.before }),
						() => scanned(ledger, [CASE], tables),
						{
							discard: true
						}
					)
					assert.equal(
						ledger.scans,
						1,
						"the tables read once, at the reading that met the server's socket"
					)
					opens(root, CASE, FOREIGN.socket)
					yield* Effect.forEach(
						Array.from({ length: counts.after }),
						() => scanned(ledger, [CASE], tables),
						{
							discard: true
						}
					)
					assert.equal(
						ledger.scans,
						2,
						"the tables read once more, at the reading that met the new socket"
					)
					assert.deepEqual(
						backendPids(ledger, [CASE]),
						[LEADER],
						"the case's backend, found throughout"
					)
				})
			),
		oracle: {
			kind: "specification",
			name: "the socket tables are read at a reading exactly when the tree holds a socket no reading classified yet: once for the server's socket, once for the socket opened since, never for a socket classified"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/backends.ts",
				original:
					"\t\tconst unclassified = Arr.filter(Arr.fromIterable(held), (inode) => !ledger.clients.has(inode))\n",
				replacement: "\t\tconst unclassified = Arr.fromIterable(held)\n",
				why: "Every reading reads the socket tables, `ss -x` and /proc/net/tcp, ~30 ms at load 400: a 40,960-case search spends ~11 minutes of CPU reading them (edullm's HANGFREE)."
			}
		]
	}
)

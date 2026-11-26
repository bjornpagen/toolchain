/**
 * What backends.test.ts reads: a /proc made to stand for the machine's (a temporary directory a ledger reads as its
 * root, runner/backends.ts ledgerAt), holding a postmaster, its children (a backend, its parallel workers, another
 * leader's worker) and the case's own process, each with its stat, its title and the sockets it holds; and the kernel's
 * Unix socket table those sockets stand in.
 */
import { Array as Arr, Effect, Order, type Scope } from "effect"
import { array, boolean, type Gen, int } from "#gen.ts"
import { type BackendLedger, backendsIn, type SocketTables } from "#runner/backends.ts"

const fs = process.getBuiltinModule("node:fs")
const os = process.getBuiltinModule("node:os")
const path = process.getBuiltinModule("node:path")

/** A process of the synthetic /proc: its pid, command, parent, start, title, the sockets it holds and its children. */
export type SyntheticProcess = Readonly<{
	pid: string
	command: string
	parent: string
	started: string
	title: string
	sockets: ReadonlyArray<string>
	children: ReadonlyArray<string>
}>

/**
 * @formatConstant proc(5): the fields /proc/<pid>/stat holds after the parent's pid (the 4th) and before the start time
 * (the 22nd), the 5th through the 21st, each 0 here.
 */
const BETWEEN_PARENT_AND_START = Arr.join(
	Arr.makeBy(17, () => "0"),
	" "
)

/** `p` written under `root` as /proc holds a process: its stat, its title, its one thread's children, its fds. */
const writeProcess = (root: string, p: SyntheticProcess): void => {
	const at = path.join(root, p.pid)
	fs.mkdirSync(path.join(at, "fd"), { recursive: true })
	fs.mkdirSync(path.join(at, "task", p.pid), { recursive: true })
	fs.writeFileSync(
		path.join(at, "stat"),
		`${p.pid} (${p.command}) S ${p.parent} ${BETWEEN_PARENT_AND_START} ${p.started} 0\n`
	)
	fs.writeFileSync(path.join(at, "cmdline"), `${p.title}\0`)
	fs.writeFileSync(
		path.join(at, "task", p.pid, "children"),
		Arr.join(
			Arr.map(p.children, (c) => `${c} `),
			""
		)
	)
	Arr.forEach(p.sockets, (inode, fd) => {
		fs.symlinkSync(`socket:[${inode}]`, path.join(at, "fd", String(fd)))
	})
}

/** A synthetic /proc holding `processes` and an empty TCP table, removed with the scope. */
export const procOf = (
	processes: ReadonlyArray<SyntheticProcess>
): Effect.Effect<string, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-proc-"))
			for (const p of processes) {
				writeProcess(root, p)
			}
			fs.mkdirSync(path.join(root, "self", "net"), { recursive: true })
			const header =
				"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
			fs.writeFileSync(path.join(root, "self", "net", "tcp"), header)
			fs.writeFileSync(path.join(root, "self", "net", "tcp6"), header)
			return root
		}),
		(root) => Effect.sync(() => fs.rmSync(root, { recursive: true, force: true }))
	)

/** The process `pid` of the synthetic /proc at `root` holding the socket `inode` too, as an fd it opened since. */
export const opens = (root: string, pid: string, inode: string): void => {
	const fds = path.join(root, pid, "fd")
	fs.symlinkSync(`socket:[${inode}]`, path.join(fds, String(fs.readdirSync(fds).length)))
}

/** A process of the synthetic /proc of no title, no socket and no child. */
const plain = (pid: string, command: string, parent: string): SyntheticProcess => ({
	pid,
	command,
	parent,
	started: "100",
	title: command,
	sockets: [],
	children: []
})

/** The case's own process. */
export const CASE = "900"
/** The postmaster, a child of init. */
const POSTMASTER = "500"
/** The case's backend, the postmaster's child serving the case's socket. */
export const LEADER = "501"
/** Another case's backend, serving no socket of the case's. */
const OTHER_LEADER = "777"

/** The case's socket to its backend, and the backend's end of it. */
const CLIENT = { socket: "100", peer: "200" } as const

/**
 * A drawn machine's parallel workers, none to two, each working for the case's backend (`true`) or for another backend
 * (`false`), so a case meets a worker of its own, another's, both or neither.
 */
export const workersGen: Gen<ReadonlyArray<boolean>> = array(boolean, { min: 0, max: 2 })

/** The pid of the drawn machine's `n`th parallel worker. */
export const workerPid = (n: number): string => String(502 + n)

/** The synthetic machine of a case whose backend `LEADER` serves its socket, beside the parallel workers `workers`. */
export const machineOf = (workers: ReadonlyArray<boolean>): ReadonlyArray<SyntheticProcess> => {
	const drawn = Arr.map(workers, (forTheCase, n): SyntheticProcess => ({
		...plain(workerPid(n), "postgres", POSTMASTER),
		started: "300",
		title: `postgres: parallel worker for PID ${forTheCase ? LEADER : OTHER_LEADER}`
	}))
	return [
		plain("1", "systemd", "0"),
		{
			...plain(POSTMASTER, "postgres", "1"),
			children: [LEADER, OTHER_LEADER, ...Arr.map(drawn, (w) => w.pid)]
		},
		{
			...plain(LEADER, "postgres", POSTMASTER),
			title: "postgres: bench bench [local] SELECT",
			sockets: [CLIENT.peer]
		},
		{
			...plain(OTHER_LEADER, "postgres", POSTMASTER),
			title: "postgres: bench bench [local] SELECT"
		},
		...drawn,
		{ ...plain(CASE, "node", "1"), sockets: [CLIENT.socket] }
	]
}

/** The pids of the backends `pids` are clients of by `ledger`, in code point order. */
export const backendPids = (
	ledger: BackendLedger,
	pids: ReadonlyArray<string>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(backendsIn(ledger, pids), (backend) => backend.pid),
		Order.String
	)

/** How many readings a case makes before it opens a socket to no server, one to three, and how many after. */
export const readingsGen: Gen<Readonly<{ before: number; after: number }>> = (source) => ({
	before: source.draw(int(1, 3)),
	after: source.draw(int(1, 3))
})

/** The kernel's tables of the synthetic machine: the case's socket to its backend's, and `foreign`, a pair of no server's. */
export const tablesOf = (foreign: Readonly<{ socket: string; peer: string }>): SocketTables => ({
	unix: new Map([
		[CLIENT.socket, { address: "*", peer: CLIENT.peer }],
		[CLIENT.peer, { address: "/run/postgresql/.s.PGSQL.5432", peer: CLIENT.socket }],
		[foreign.socket, { address: "*", peer: foreign.peer }],
		[foreign.peer, { address: "/run/pool/channel", peer: foreign.socket }]
	]),
	tcp: []
})

/** A socket the case opens later to no server, and its peer. */
export const FOREIGN = { socket: "101", peer: "300" } as const

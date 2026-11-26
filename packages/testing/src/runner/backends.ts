import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Record as Rec, Result, String as Str } from "effect"
import { unwatched } from "#runner/observe.ts"

/**
 * The PostgreSQL backends a process tree is the client of, found by construction from the tree's own sockets, never by a
 * database's name: a backend is the tree's when the socket it serves is the peer of a socket a process of the tree holds
 * (/proc/<pid>/fd), so sibling cases on one database lend each other nothing, and a database the toolchain never opened
 * (a consumer's own pool, a copy made by CREATE DATABASE, a migration's connection) is found like any other.
 *
 * Each socket the tree holds is classified once for its life, by its inode, which sockfs never gives another socket while
 * one holds it (BackendLedger `clients`): a client of a server, by the peer socket the server holds, or foreign. A
 * reading lists the tree's sockets (its fd links) and reads the kernel's socket tables only when the tree holds a socket
 * not classified yet, so a case whose connections a pool opened before it reads no table at all (edullm's HANGFREE,
 * 2026-11-26: `ss -x` 14 ms and /proc/net/tcp 16 ms at load 400, ~11 min of CPU over a 40,960-case search if read at
 * each case):
 *
 * - A Unix-domain socket's peer is read off the kernel's socket table (`ss -x`, sock_diag, never `-p`), which a helper
 *   process reads for the process, started once and never reaped, so neither its CPU nor `ss`'s is any work's
 *   (observerPids). A socket whose peer is bound to a PostgreSQL socket (`.s.PGSQL.<port>`, the path an accepted socket
 *   holds as its own address) is a server's client, held by its backend once the postmaster forks it; every other
 *   (a worker's channel to its pool, a listener, an unconnected socket) is foreign.
 * - A TCP socket is a server's client where its remote port is one a postmaster listens on, and its peer is the socket
 *   of this process's network whose ends are its own swapped (/proc/self/net/tcp, tcp6). A peer not accepted yet (inode
 *   0), or held by a postmaster itself between its accept and its fork, or a connect not established yet, is classified
 *   at a later reading; every socket to another port, or to a remote host, is foreign.
 * - A peer socket's owner is a child of a postmaster (a process named postgres whose parent is not), its fds read once
 *   for each backend and kept while it lives.
 * - A backend's parallel workers are the postmaster's children titled `parallel worker for PID <leader>`, the title
 *   init_ps_display sets at a worker's start whatever update_process_title says, read once for each child: their work
 *   is the leader's, so the tree's, from their start. A worker that starts and ends between two readings goes unseen; its
 *   leader, which runs its share of the plan beside them, moves the tree's work all the same.
 *
 * What a backend waits on is asked of its server, when the process holds a monitor of it (registerServerAt, the toolchain's
 * PostgreSQL sessions register theirs): a backend behind a heavyweight lock is carried by the holders that work (active
 * and behind no lock) or sit between statements, at any remove (pg_blocking_pids), and by none where every holder is
 * idle in a transaction or the holders wait on each other; a backend waiting on a checkpoint (CREATE DATABASE's
 * FILE_COPY) is carried by the checkpointer, and one waiting on I/O by the server's I/O workers (io_method=worker),
 * which every backend of the server shares, so they are no tree's own work. A carrier's CPU moves the work its wait is
 * part of and spends none of its budget (runner/work.ts Effort carried). A server no monitor of the process asks
 * carries nothing: a window its backend spends wholly waiting on I/O there reads as a stall.
 */

const { readFileSync, readdirSync, readlinkSync, spawn } = unwatched

const { Socket } = process.getBuiltinModule("node:net")

/**
 * @formatConstant proc(5): a socket's fd links to `socket:[<inode>]`; /proc/<pid>/stat holds the command in
 * parentheses, then, from the third field, the state, the parent's pid (the 4th) and the start time (the 22nd);
 * /proc/<pid>/cmdline holds the title a process set over its arguments, NUL-padded; /proc/net/tcp and tcp6 hold one
 * socket a line after a header, its local and remote `<hex address>:<hex port>` the 2nd and 3rd fields, its state the
 * 4th (`01` established, `0A` listening, `02` a connect sent) and its inode the 10th (0 for a connection no process
 * accepted yet). ss(8) -x -H -n prints a Unix socket a line: its kind, its state, its queues, then its address and
 * inode, and its peer's address and inode (0 for none). PostgreSQL's Unix socket is `<dir>/.s.PGSQL.<port>`, and its
 * parallel worker's title ends `parallel worker for PID <leader>` (access/transam/parallel.c).
 */
const FORMAT = {
	socketPrefix: "socket:[",
	socketSuffix: "]",
	postgres: "postgres",
	established: "01",
	connecting: "02",
	listening: "0A",
	unaccepted: "0",
	tcpLocal: 1,
	tcpRemote: 2,
	tcpState: 3,
	tcpInode: 9,
	ssAddress: 4,
	ssInode: 5,
	ssPeerInode: 7,
	noPeer: "0",
	pgSocket: regex("/\\.s\\.PGSQL\\.[0-9]+$"),
	parallelWorker: regex("parallel worker for PID ([0-9]+)$")
} as const

/** A file's text, none when it cannot be read. */
const textOf = (path: string): Option.Option<string> =>
	Result.getSuccess(Result.try(() => readFileSync(path, "utf8")))

/** A directory's entries, none when it cannot be read. */
const entriesOf = (path: string): ReadonlyArray<string> =>
	Option.getOrElse(Result.getSuccess(Result.try(() => readdirSync(path))), () => [])

/** The link a path names, none when it cannot be read. */
const linkOf = (path: string): Option.Option<string> =>
	Result.getSuccess(Result.try(() => readlinkSync(path)))

/** The inodes of the sockets a process holds. */
const socketsAt = (root: string, pid: string): ReadonlyArray<string> =>
	Arr.flatMap(entriesOf(`${root}/${pid}/fd`), (fd) =>
		Option.match(linkOf(`${root}/${pid}/fd/${fd}`), {
			onNone: () => [],
			onSome: (link) =>
				Str.startsWith(FORMAT.socketPrefix)(link) && Str.endsWith(FORMAT.socketSuffix)(link)
					? [Str.slice(FORMAT.socketPrefix.length, -FORMAT.socketSuffix.length)(link)]
					: []
		})
	)

/** A process's command, parent and start, none for a process gone. */
const commandAt = (
	root: string,
	pid: string
): Option.Option<Readonly<{ command: string; parent: string; started: string }>> =>
	Option.flatMap(textOf(`${root}/${pid}/stat`), (stat) =>
		Option.map(
			Option.all([Str.indexOf("(")(stat), Str.lastIndexOf(")")(stat)]),
			([opening, closing]) => {
				const fields = Str.split(" ")(Str.trim(Str.slice(closing + 1)(stat)))
				return {
					command: Str.slice(opening + 1, closing)(stat),
					parent: fields[1] ?? "",
					started: fields[19] ?? ""
				}
			}
		)
	)

/** The leader a process's title names it a parallel worker for, none for any other process. */
const leaderAt = (root: string, pid: string): Option.Option<string> =>
	Option.flatMap(textOf(`${root}/${pid}/cmdline`), (cmdline) =>
		Option.flatMap(
			Str.match(FORMAT.parallelWorker)(Str.trim(Str.replaceAll("\0", " ")(cmdline))),
			(match) => Option.fromUndefinedOr(match[1])
		)
	)

/** The children of a process, every thread's. */
const childrenAt = (root: string, pid: string): ReadonlyArray<string> =>
	Arr.flatMap(entriesOf(`${root}/${pid}/task`), (thread) =>
		Option.match(textOf(`${root}/${pid}/task/${thread}/children`), {
			onNone: () => [],
			onSome: (text) => Arr.filter(Str.split(" ")(Str.trim(text)), Str.isNonEmpty)
		})
	)

/** A TCP socket of this process's network: its inode, its state and its two ends. */
type TcpSocket = Readonly<{ inode: string; state: string; local: string; remote: string }>

/** The TCP sockets of this process's network, every state's. */
const tcpSocketsAt = (root: string): ReadonlyArray<TcpSocket> =>
	Arr.flatMap([`${root}/self/net/tcp`, `${root}/self/net/tcp6`], (path) =>
		Option.match(textOf(path), {
			onNone: () => [],
			onSome: (text) =>
				Arr.flatMap(Arr.drop(Str.split("\n")(text), 1), (line) => {
					const fields = Arr.filter(Str.split(" ")(Str.trim(line)), Str.isNonEmpty)
					const inode = fields[FORMAT.tcpInode]
					const state = fields[FORMAT.tcpState]
					const local = fields[FORMAT.tcpLocal]
					const remote = fields[FORMAT.tcpRemote]
					return inode !== undefined &&
						state !== undefined &&
						local !== undefined &&
						remote !== undefined
						? [{ inode, state, local, remote }]
						: []
				})
		})
	)

/** A Unix socket of the kernel's table: its own address and its peer's inode (FORMAT.noPeer for none). */
type UnixSocket = Readonly<{ address: string; peer: string }>

/** Each Unix socket of the kernel's table by inode, as `ss -x -H -n` printed it. */
const unixSocketsOf = (table: string): ReadonlyMap<string, UnixSocket> =>
	new Map(
		Arr.flatMap(Str.split("\n")(table), (line) => {
			const fields = Arr.filter(Str.split(" ")(Str.trim(line)), Str.isNonEmpty)
			const address = fields[FORMAT.ssAddress]
			const inode = fields[FORMAT.ssInode]
			const peer = fields[FORMAT.ssPeerInode]
			return address !== undefined && inode !== undefined && peer !== undefined
				? [[inode, { address, peer }] as const]
				: []
		})
	)

/**
 * What a socket the tree holds is, for its life: a client of a server, whose `peer` socket a backend holds once the
 * postmaster forks it, or foreign, no server's.
 */
export type Client = Readonly<{ kind: "server"; peer: string }> | Readonly<{ kind: "foreign" }>

/** The kernel's socket tables as one reading read them. */
export type SocketTables = Readonly<{
	unix: ReadonlyMap<string, UnixSocket>
	tcp: ReadonlyArray<TcpSocket>
}>

/** A TCP end's port, `<hex address>:<hex port>`'s last field. */
const portOf = (end: string): string => Option.getOrElse(Arr.last(Str.split(":")(end)), () => "")

/**
 * The servers as one scan of the tables sees them: the ports a postmaster listens on (`ports`, hex, a LISTEN socket a
 * postmaster holds), and whether a postmaster itself holds a socket (`holds`), which it does between its accept and its
 * fork.
 */
type Servers = Readonly<{ ports: ReadonlySet<string>; holds: (inode: string) => boolean }>

/**
 * What the socket `inode` is (Client), by the tables and the servers: none where it cannot be told yet (a connect to a
 * server's port not established, a server's peer no process accepted yet, or one a postmaster holds between its
 * accept and its fork), so a later reading classifies it. A TCP socket to no server's port is foreign whatever holds its
 * peer, so a connection to another kind of server (a test's own HTTP server, a cache) is classified once and never
 * reads the tables again.
 */
const clientOf = (inode: string, tables: SocketTables, servers: Servers): Option.Option<Client> => {
	const foreign: Option.Option<Client> = Option.some({ kind: "foreign" })
	const unix = tables.unix.get(inode)
	if (unix !== undefined) {
		const peer = unix.peer === FORMAT.noPeer ? undefined : tables.unix.get(unix.peer)
		return peer !== undefined && FORMAT.pgSocket.test(peer.address)
			? Option.some({ kind: "server", peer: unix.peer })
			: foreign
	}
	const tcp = Arr.findFirst(tables.tcp, (socket) => socket.inode === inode)
	if (Option.isNone(tcp) || !servers.ports.has(portOf(tcp.value.remote))) {
		return foreign
	}
	const own = tcp.value
	if (own.state === FORMAT.connecting) {
		return Option.none()
	}
	if (own.state !== FORMAT.established) {
		return foreign
	}
	return Option.match(
		Arr.findFirst(
			tables.tcp,
			(socket) =>
				socket.state === FORMAT.established &&
				socket.local === own.remote &&
				socket.remote === own.local
		),
		{
			onNone: () => foreign,
			onSome: (peer): Option.Option<Client> =>
				peer.inode === FORMAT.unaccepted || servers.holds(peer.inode)
					? Option.none()
					: Option.some({ kind: "server", peer: peer.inode })
		}
	)
}

/** The servers as `ledger`'s postmasters and `tables` show them (Servers). */
const serversOf = (ledger: BackendLedger, tables: SocketTables): Servers => {
	const held = new Set(
		Arr.flatMap(ledger.postmasters, (postmaster) => socketsAt(ledger.root, postmaster))
	)
	return {
		ports: new Set(
			Arr.flatMap(tables.tcp, (socket) =>
				socket.state === FORMAT.listening && held.has(socket.inode) ? [portOf(socket.local)] : []
			)
		),
		holds: (peer) => held.has(peer)
	}
}

/**
 * `read`'s value, the CPU the main thread spent on it counted as the process's observing (observedMicros), which no
 * case spends: the socket tables' parse and a walk of the servers' children read no case's work, and counted as a
 * case's they read as its progress (a stall never whole) and spent its budget. Kept by the process itself, whether or
 * not a watchdog runs in it, so a guard outside a watched case subtracts it too.
 */
const observed = <A>(ledger: BackendLedger, read: () => A): A => {
	const before = process.threadCpuUsage()
	const value = read()
	const spent = process.threadCpuUsage(before)
	ledger.observed += spent.user + spent.system
	return value
}

/** The CPU, in microseconds, this process has spent reading the backends around it (observed): no case's. */
export const observedMicros = (): number => ledgerOf().observed

/** A backend: its pid, its start (so a pid used again is another), and its postmaster. */
export type Backend = Readonly<{ pid: string; started: string; postmaster: string }>

/** What a backend's server says its wait is carried by: the pids whose CPU moves it. */
export type Carriers = (
	backends: ReadonlyArray<string>
) => Promise<ReadonlyMap<string, ReadonlyArray<string>>>

/**
 * A process's view of the backends around it, kept between readings: the /proc it reads, the helper that reads the Unix
 * socket table, the postmasters found, each socket the tree held classified (Client, by inode), each backend's socket
 * by inode, each parallel worker by its leader, the servers' children read, the servers it may ask (by postmaster pid),
 * and the carriers each backend's server last named.
 */
export type BackendLedger = {
	readonly root: string
	helper: Option.Option<Readonly<{ pid: string; ask: Effect.Effect<string> }>>
	postmasters: ReadonlyArray<string>
	clients: Map<string, Client>
	served: Map<string, Backend>
	workers: Map<string, Readonly<{ worker: Backend; leader: string }>>
	known: Set<string>
	servers: Map<string, Carriers>
	carried: ReadonlyMap<string, ReadonlyArray<string>>
	observers: Set<string>
	observed: number
	scans: number
}

/** A ledger of nothing yet over the /proc at `root`. */
export const ledgerAt = (root: string): BackendLedger => ({
	root,
	helper: Option.none(),
	postmasters: [],
	clients: new Map(),
	served: new Map(),
	workers: new Map(),
	known: new Set(),
	servers: new Map(),
	carried: new Map(),
	observers: new Set(),
	observed: 0,
	scans: 0
})

declare global {
	var bjornpagenTestingBackends: BackendLedger | undefined
}

/** The process's own ledger, over the machine's /proc. */
const ledgerOf = (): BackendLedger => {
	globalThis.bjornpagenTestingBackends ??= ledgerAt("/proc")
	return globalThis.bjornpagenTestingBackends
}

/** The processes no work counts: the helper that reads the socket table for this process. */
export const observerPids = (): ReadonlySet<string> =>
	new Set(Option.toArray(Option.map(ledgerOf().helper, (helper) => helper.pid)))

/**
 * A server this process may ask what its backends wait on, by the socket it listens on: its postmaster's pid is the
 * first line of the socket's lock file (`<dir>/.s.PGSQL.<port>.lock`, PostgreSQL's), none where it cannot be read.
 */
export const registerServerAt = (socket: string, port: number, carriers: Carriers): void => {
	Option.map(
		Option.flatMap(textOf(`${socket}/.s.PGSQL.${String(port)}.lock`), (text) =>
			Arr.head(Str.split("\n")(Str.trim(text)))
		),
		(postmaster) => ledgerOf().servers.set(Str.trim(postmaster), carriers)
	)
}

/** A backend no work counts: the one a monitor of this process asks its server through (pg/session.ts monitorOf). */
export const observeBackend = (pid: string): void => {
	ledgerOf().observers.add(pid)
}

/** The postmasters of the machine: the processes named postgres whose parent is not. */
const postmastersAt = (root: string): ReadonlyArray<string> =>
	Arr.filter(
		Arr.filter(
			entriesOf(root),
			(entry) => Str.isNonEmpty(entry) && Number.isInteger(Number(entry))
		),
		(pid) =>
			Option.exists(
				commandAt(root, pid),
				(process) =>
					process.command === FORMAT.postgres &&
					!Option.exists(
						commandAt(root, process.parent),
						(parent) => parent.command === FORMAT.postgres
					)
			)
	)

/**
 * Each postmaster's children not read yet, each read once: its sockets into the ledger's backends, its title into its
 * parallel workers; children gone are let go.
 */
const readServed = (ledger: BackendLedger): void => {
	const live = new Set<string>()
	for (const postmaster of ledger.postmasters) {
		for (const child of childrenAt(ledger.root, postmaster)) {
			Option.map(commandAt(ledger.root, child), (process) => {
				const key = `${child}@${process.started}`
				live.add(key)
				if (ledger.known.has(key)) {
					return
				}
				ledger.known.add(key)
				const backend = { pid: child, started: process.started, postmaster }
				for (const inode of socketsAt(ledger.root, child)) {
					ledger.served.set(inode, backend)
				}
				Option.map(leaderAt(ledger.root, child), (leader) =>
					ledger.workers.set(key, { worker: backend, leader })
				)
			})
		}
	}
	for (const key of ledger.known) {
		if (!live.has(key)) {
			ledger.known.delete(key)
			ledger.workers.delete(key)
		}
	}
	for (const [inode, backend] of ledger.served) {
		if (!live.has(`${backend.pid}@${backend.started}`)) {
			ledger.served.delete(inode)
		}
	}
}

/** The sockets the processes of `pids` hold. */
const heldBy = (ledger: BackendLedger, pids: ReadonlyArray<string>): ReadonlySet<string> =>
	new Set(Arr.flatMap(pids, (pid) => socketsAt(ledger.root, pid)))

/**
 * The ledger brought up to the sockets `pids` hold: a socket no longer held let go; the socket tables read, by `tables`,
 * only where a held socket is not classified yet, each such socket classified (clientOf); and where a held socket is a
 * server's client, the servers' children read again (readServed), the machine's postmasters too where its peer is no
 * backend's yet, so a backend forked since and a parallel worker started since are found.
 */
export const scanned = (
	ledger: BackendLedger,
	pids: ReadonlyArray<string>,
	tables: Effect.Effect<SocketTables>
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const held = observed(ledger, () => heldBy(ledger, pids))
		for (const inode of ledger.clients.keys()) {
			if (!held.has(inode)) {
				ledger.clients.delete(inode)
			}
		}
		const unclassified = Arr.filter(Arr.fromIterable(held), (inode) => !ledger.clients.has(inode))
		if (Arr.isReadonlyArrayNonEmpty(unclassified)) {
			ledger.scans += 1
			const read = yield* tables
			observed(ledger, () => {
				if (
					Arr.some(unclassified, (inode) => Arr.some(read.tcp, (socket) => socket.inode === inode))
				) {
					ledger.postmasters = postmastersAt(ledger.root)
				}
				const servers = serversOf(ledger, read)
				for (const inode of unclassified) {
					Option.map(clientOf(inode, read, servers), (client) => ledger.clients.set(inode, client))
				}
			})
		}
		observed(ledger, () => {
			const peers = Arr.flatMap(Arr.fromIterable(ledger.clients.values()), (client) =>
				client.kind === "server" ? [client.peer] : []
			)
			if (Arr.isReadonlyArrayNonEmpty(peers)) {
				readServed(ledger)
				if (Arr.some(peers, (peer) => !ledger.served.has(peer))) {
					ledger.postmasters = postmastersAt(ledger.root)
					readServed(ledger)
				}
			}
		})
	})

/** A backend's key as a leader of parallel workers: its server's postmaster and its pid. */
const leaderKey = (postmaster: string, pid: string): string => `${postmaster}:${pid}`

/**
 * The backends `pids` are clients of, as the ledger last classified their sockets and read the servers' children: each
 * backend holding the peer of a socket a process of the tree holds, and each parallel worker such a backend leads.
 */
export const backendsIn = (
	ledger: BackendLedger,
	pids: ReadonlyArray<string>
): ReadonlyArray<Backend> => {
	const leaders = Arr.dedupeWith(
		Arr.flatMap(Arr.fromIterable(heldBy(ledger, pids)), (inode): ReadonlyArray<Backend> => {
			const client = ledger.clients.get(inode)
			return client?.kind === "server"
				? Option.toArray(Option.fromUndefinedOr(ledger.served.get(client.peer)))
				: []
		}),
		(one: Backend, other: Backend) => one.pid === other.pid && one.started === other.started
	)
	const leading = new Set(Arr.map(leaders, (backend) => leaderKey(backend.postmaster, backend.pid)))
	const workers = Arr.flatMap(Arr.fromIterable(ledger.workers.values()), ({ worker, leader }) =>
		leading.has(leaderKey(worker.postmaster, leader)) ? [worker] : []
	)
	return Arr.filter([...leaders, ...workers], (backend) => !ledger.observers.has(backend.pid))
}

/** The backends `pids` are clients of (backendsIn), by the process's own ledger. */
export const backendsOf = (pids: ReadonlyArray<string>): ReadonlyArray<Backend> =>
	backendsIn(ledgerOf(), pids)

/** The pids whose CPU carries `backend`'s wait, as its server last said; none where it waits on nothing or was not asked. */
export const carriersOf = (backend: Backend): ReadonlyArray<string> =>
	ledgerOf().carried.get(backend.pid) ?? []

/**
 * The helper that prints the Unix socket table when asked, started once for the process and never reaped (observerPids):
 * a helper that ended (no `ss` on the machine, killed) answers every ask with an empty table, and the next ask starts
 * another, so no reading waits on a helper that is gone. The helper holds its process open only while an ask waits on
 * its answer: the child, its standard input and its standard output are unreferenced, the output referenced again for
 * each ask until its table comes, so a process that read its backends ends when its own work does, where the helper's
 * pipes held every `toolchain-test run` and replay open after its last verdict (the toolchain merge's gate, 2026-11-26:
 * runner/reuse.test.ts aRunAnswersFromItsKeyAlone's consumer runs held 90 minutes past their reports). It ends as its
 * process does, its standard input closed.
 */
const helperOf = (ledger: BackendLedger): Readonly<{ pid: string; ask: Effect.Effect<string> }> =>
	Option.getOrElse(ledger.helper, () => {
		const child = spawn("sh", ["-c", "while read -r _; do ss -x -H -n; echo .; done"], {
			stdio: ["pipe", "pipe", "ignore"]
		})
		child.unref()
		unreferenced(child.stdin)
		unreferenced(child.stdout)
		const waiting: Array<(table: string) => void> = []
		let buffered = ""
		const ended = () => {
			ledger.helper = Option.none()
			for (const answer of waiting.splice(0)) {
				answer("")
			}
		}
		child.on("exit", ended)
		child.on("error", ended)
		child.stdin.on("error", ended)
		child.stdout.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			buffered += chunk
			for (;;) {
				const end = Str.indexOf("\n.\n")(buffered)
				if (Option.isNone(end)) {
					return
				}
				const table = Str.slice(0, end.value)(buffered)
				buffered = Str.slice(end.value + 3)(buffered)
				waiting.shift()?.(table)
				if (waiting.length === 0) {
					unreferenced(child.stdout)
				}
			}
		})
		const helper = {
			pid: String(child.pid ?? ""),
			ask: Effect.callback<string>((resume) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resume(Effect.succeed(""))
					return
				}
				waiting.push((table) => resume(Effect.succeed(table)))
				referenced(child.stdout)
				child.stdin.write("\n")
			})
		}
		ledger.helper = Option.some(helper)
		return helper
	})

/** A pipe of the helper's no longer holding this process open (net.Socket unref): every pipe of a child's stdio is one. */
const unreferenced = (pipe: unknown): void => {
	if (pipe instanceof Socket) {
		pipe.unref()
	}
}

/** A pipe of the helper's holding this process open again (net.Socket ref), while an ask waits on it. */
const referenced = (pipe: unknown): void => {
	if (pipe instanceof Socket) {
		pipe.ref()
	}
}

/** The machine's socket tables, read for `ledger`: the Unix table its helper prints, and this network's TCP sockets. */
const tablesOf = (ledger: BackendLedger): Effect.Effect<SocketTables> =>
	Effect.map(helperOf(ledger).ask, (table) =>
		observed(ledger, () => ({ unix: unixSocketsOf(table), tcp: tcpSocketsAt(ledger.root) }))
	)

/** The ledger brought up to the sockets `pids` hold (scanned), and each of their backends asked of its server (Carriers). */
const refreshed = (ledger: BackendLedger, pids: () => ReadonlyArray<string>): Effect.Effect<void> =>
	Effect.gen(function* () {
		const tree = pids()
		yield* scanned(ledger, tree, tablesOf(ledger))
		const backends = observed(ledger, () => backendsIn(ledger, tree))
		const answers = yield* Effect.forEach(
			Rec.toEntries(Arr.groupBy(backends, (backend) => backend.postmaster)),
			([postmaster, served]) =>
				Option.match(Option.fromUndefinedOr(ledger.servers.get(postmaster)), {
					onNone: () => Effect.succeed(new Map<string, ReadonlyArray<string>>()),
					onSome: (ask) =>
						Effect.orElseSucceed(
							Effect.tryPromise({
								try: () => ask(Arr.map(served, (backend) => backend.pid)),
								catch: () => "unasked" as const
							}),
							(): ReadonlyMap<string, ReadonlyArray<string>> => new Map()
						)
				})
		)
		ledger.carried = new Map(Arr.flatMap(answers, (answer) => Arr.fromIterable(answer)))
	})

/**
 * The work's backends found again and each asked of its server, before a guard's reading, so the reading judges what
 * its tree's backends did up to it: the socket tables are read only for a socket the tree opened since (scanned), the
 * Unix table the helper's, which answers at once or, gone, with nothing; each server is asked on its bounded monitor
 * (pg/session.ts monitorBoundMillis), and one that does not answer within its bound carries nothing, so no guard waits on
 * a server past that bound (trunk@toolchain at e8b7ecec, 2026-11-22: a guard waited 69 minutes on an unbounded connect
 * a busy member never answered, and judged nothing).
 */
export const refreshBackends = (pids: () => ReadonlyArray<string>): Effect.Effect<void> =>
	Effect.suspend(() => refreshed(ledgerOf(), pids))

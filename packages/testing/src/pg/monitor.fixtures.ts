import { Effect, Option, Redacted, type Scope } from "effect"
import type { PgMember } from "#pg/settle.ts"

/**
 * A member that takes every connection and never answers, for the carrier asks' monitor (pg/session.ts monitorOf): a
 * socket at a member's path in a directory of the scope's own, whose server accepts and writes nothing.
 *
 * @module
 */

/** Node's sockets and files, as the process holds them. */
const net = process.getBuiltinModule("node:net")
const fs = process.getBuiltinModule("node:fs")
const os = process.getBuiltinModule("node:os")
const path = process.getBuiltinModule("node:path")

/** The port a silent member's socket is named for, as PostgreSQL names its socket `.s.PGSQL.<port>`. */
const SILENT_PORT = 5999

/** A member at a socket of the scope's own whose server takes each connection and never answers, closed with the scope. */
export const silentMember: Effect.Effect<PgMember, never, Scope.Scope> = Effect.acquireRelease(
	Effect.callback<Readonly<{ member: PgMember; close: () => void }>>((resume) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-silent-member-"))
		const held: Array<ReturnType<typeof net.createConnection>> = []
		const server = net.createServer((socket) => {
			held.push(socket)
		})
		server.listen(path.join(directory, `.s.PGSQL.${String(SILENT_PORT)}`), () =>
			resume(
				Effect.succeed({
					member: {
						name: "silent-0",
						socket: directory,
						port: SILENT_PORT,
						owner: "silent",
						password: Redacted.make(""),
						passwordFile: "",
						tls: { kind: "socket" }
					},
					close: () => {
						for (const socket of held) {
							socket.destroy()
						}
						server.close()
						fs.rmSync(directory, { recursive: true, force: true })
					}
				})
			)
		)
	}),
	(opened) => Effect.sync(() => opened.close())
).pipe(Effect.map((opened) => opened.member))

/** Whether this process holds a monitor connection to `member` now. */
export const monitored = (member: PgMember): boolean =>
	Option.isSome(
		Option.fromUndefinedOr(
			globalThis.bjornpagenTestingMonitors?.get(`${member.socket}:${String(member.port)}`)
		)
	)

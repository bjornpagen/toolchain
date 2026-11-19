import { lookup } from "node:dns/promises"
import { createServer } from "node:net"
import { Array as Arr, Effect, Schema } from "effect"

/** A port cannot be listened on at an address localhost names: it is taken there, or not this user's. */
class PortTaken extends Schema.TaggedError<PortTaken, { readonly brand: unique symbol }>()(
	"PortTaken",
	{
		message: Schema.String
	}
) {}

/** localhost's addresses cannot be read. */
class LocalhostUnresolved extends Schema.TaggedError<
	LocalhostUnresolved,
	{ readonly brand: unique symbol }
>()("LocalhostUnresolved", { message: Schema.String }) {}

/** A failure's text, as an error's message or the value's own. */
const textOf = (cause: unknown): string => (Error.isError(cause) ? cause.message : String(cause))

/**
 * Listens on `port` at `address` and closes again: the port it listened on, the one the system chose when `port` is 0,
 * or why it could not.
 */
const listened = (address: string, port: number): Effect.Effect<number, PortTaken> =>
	Effect.callback<number, PortTaken>((resume) => {
		const server = createServer()
		server.once("error", (cause) => {
			resume(
				Effect.fail(PortTaken.make({ message: `port ${port} at ${address}: ${cause.message}` }))
			)
		})
		server.listen({ port, host: address, exclusive: true }, () => {
			const bound = server.address()
			server.close(() => {
				resume(
					bound === null || typeof bound === "string"
						? Effect.die(new Error(`a TCP listener at ${address} reported no port`))
						: Effect.succeed(bound.port)
				)
			})
		})
	})

/**
 * The addresses localhost names, each of which a member's listen_addresses = 'localhost' binds (make.ts), the first the
 * one the system resolves first.
 */
const localhostAddresses: Effect.Effect<
	Arr.NonEmptyReadonlyArray<string>,
	LocalhostUnresolved
> = Effect.flatMap(
	Effect.tryPromise({
		try: () => lookup("localhost", { all: true }),
		catch: (cause) =>
			LocalhostUnresolved.make({
				message: `localhost's addresses cannot be read: ${textOf(cause)}`
			})
	}),
	(found) => {
		const addresses = Arr.map(found, ({ address }) => address)
		return Arr.isReadonlyArrayNonEmpty(addresses)
			? Effect.succeed(addresses)
			: Effect.fail(LocalhostUnresolved.make({ message: "localhost names no address" }))
	}
)

/**
 * Succeeds when `port` is free on every address localhost names, and otherwise fails with the first address it is taken
 * at: a member listens on all of them, so a port taken on any one is no member's.
 */
export const portFree = (port: number): Effect.Effect<void, PortTaken | LocalhostUnresolved> =>
	Effect.flatMap(localhostAddresses, (addresses) =>
		Effect.forEach(addresses, (address) => listened(address, port), { discard: true })
	)

/**
 * A port free on every address localhost names and not in `taken`, found as the system finds one: it listens on port 0
 * at localhost's first address, takes the port the system chose, and keeps it when it is free at every other address
 * too and is not in `taken`, else asks again. No port is derived from another, so none can fall on a port a process
 * this library does not know of holds. A port is free when this returns; whoever takes it next listens on it first.
 */
export const freePort = (
	taken: ReadonlyArray<number>
): Effect.Effect<number, LocalhostUnresolved> =>
	Effect.flatMap(localhostAddresses, (addresses) => {
		const [first] = addresses
		const attempt: Effect.Effect<number, LocalhostUnresolved> = Effect.flatMap(
			Effect.orDie(listened(first, 0)),
			(port) =>
				taken.includes(port)
					? attempt
					: Effect.matchEffect(portFree(port), {
							onFailure: (error) =>
								error._tag === "LocalhostUnresolved" ? Effect.fail(error) : attempt,
							onSuccess: () => Effect.succeed(port)
						})
		)
		return attempt
	})

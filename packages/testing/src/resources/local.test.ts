/**
 * The fixture's cluster is this machine's alone (resources.fixtures.ts localHostOf): libpq's PGHOST is taken only when
 * it names a Unix socket's directory or a loopback address, and any other host is refused, naming it, before anything
 * connects, builds or collects. Oracle: each host is labelled local or remote by how it was built.
 */
import { Effect, Result, String as Str } from "effect"
import { assertTrue, strictEqual } from "#assert.ts"
import { property } from "#property.ts"
import { hosts } from "#resources/local.fixtures.ts"
import { localHostOf } from "#resources/resources.fixtures.ts"

export const localHostsOnly = property.explore(hosts, {
	needs: {},
	situations: [
		"a socket directory",
		"a loopback address",
		"another machine's address",
		"a name or path that only looks local"
	],
	check:
		(_resources, c) =>
		({ host: text, local, situation }) =>
			Effect.sync(() => {
				c.note(situation)
				const parsed = localHostOf(text)
				strictEqual(Result.isSuccess(parsed), local)
				Result.match(parsed, {
					onSuccess: (found) =>
						strictEqual(found.kind, Str.startsWith("/")(text) ? "socket" : "loopback"),
					onFailure: (refused) => assertTrue(Str.includes(text)(refused.message))
				})
			}),
	oracle: {
		kind: "specification",
		name: "a host is taken exactly when it is a Unix socket's directory or a loopback address, labelled so as it was built"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/resources.fixtures.ts",
			original: "octets[0] === 127 &&",
			replacement: "octets[0] !== 256 &&",
			why: "Any IPv4 address is taken for loopback, so PGHOST could point the properties, and collection, at another machine's server; the property fails."
		},
		{
			file: "packages/testing/src/resources/resources.fixtures.ts",
			original: 'Str.startsWith("/")(host)',
			replacement: 'Str.includes("/")(host)',
			why: "A relative path is taken for a socket directory, which libpq would resolve as a host name; the property fails."
		}
	]
})

/**
 * The fixture's cluster is this machine's alone (resources.fixtures.ts localHostOf): libpq's PGHOST is taken only when
 * it names a Unix socket's directory or a loopback address, and any other host is refused, naming it, before anything
 * connects, builds or collects. Oracle: each host is labelled local or remote by how it was built.
 */
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { assertTrue, strictEqual } from "#assert.ts"
import { array, type Gen, int } from "#gen.ts"
import { property } from "#property.ts"
import { localHostOf } from "#resources/resources.fixtures.ts"

/** A host as built: its text, whether it is this machine's, and the situation it stands for. */
type Host = Readonly<{
	host: string
	local: boolean
	situation:
		| "a socket directory"
		| "a loopback address"
		| "another machine's address"
		| "a name or path that only looks local"
}>

/** A word of lowercase letters, one to six of them. */
const word: Gen<string> = (source) =>
	Arr.join(
		Arr.map(source.draw(array(int(97, 122), { min: 1, max: 6 })), (code) =>
			String.fromCodePoint(code)
		),
		""
	)

/** An IPv4 octet. */
const octet = int(0, 255)

const host: Gen<Host> = (source) => {
	switch (source.draw(int(0, 7))) {
		case 0:
			return {
				host: `/${Arr.join(source.draw(array(word, { min: 1, max: 4 })), "/")}`,
				local: true,
				situation: "a socket directory"
			}
		case 1:
			return {
				host: `127.${source.draw(octet)}.${source.draw(octet)}.${source.draw(octet)}`,
				local: true,
				situation: "a loopback address"
			}
		case 2:
			return {
				host: source.draw(int(0, 1)) === 0 ? "localhost" : "::1",
				local: true,
				situation: "a loopback address"
			}
		case 3: {
			const first = source.draw(int(0, 254))
			return {
				host: `${first >= 127 ? first + 1 : first}.${source.draw(octet)}.${source.draw(octet)}.${source.draw(octet)}`,
				local: false,
				situation: "another machine's address"
			}
		}
		case 4:
			return {
				host: `${source.draw(word)}.${source.draw(word)}`,
				local: false,
				situation: "another machine's address"
			}
		case 5:
			return {
				host: `127.0.${source.draw(octet)}.${source.draw(int(256, 999))}`,
				local: false,
				situation: "a name or path that only looks local"
			}
		case 6:
			return {
				host: `localhost.${source.draw(word)}`,
				local: false,
				situation: "a name or path that only looks local"
			}
		default:
			return {
				host: `${source.draw(word)}/${source.draw(word)}`,
				local: false,
				situation: "a name or path that only looks local"
			}
	}
}

export const localHostsOnly = property.explore(host, {
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

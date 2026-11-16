import { Array as Arr } from "effect"
import { array, type Gen, int } from "#gen.ts"

/** What the local-host property (local.test.ts) draws: hosts built local or remote, each labelled as it was built. */

/** A host as built: its text, whether it is this machine's, and the situation it stands for. */
export type Host = Readonly<{
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

export const hosts: Gen<Host> = (source) => {
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

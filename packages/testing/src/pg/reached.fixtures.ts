import { type Gen, element, int, oneOf } from "#gen.ts"

/** What the reached-port property (reached.test.ts) draws: TOOLCHAIN_PG_CLUSTER as a process may hold it. */

/** A name as built: unset, a port in canonical decimal, or a port misspelled one way or text that is no port. */
export type Name =
	| Readonly<{ kind: "unset" }>
	| Readonly<{ kind: "port"; port: number }>
	| Readonly<{ kind: "misspelled"; text: string; misspelling: Misspelling }>

/** The ways a name is no cluster's, each refused by name. */
export type Misspelling =
	| "a leading zero"
	| "a sign"
	| "a fraction"
	| "an exponent"
	| "no digits"
	| "the empty name"
	| "past the last port"
	| "port zero"

/** A misspelling of `port`, one way each. */
const misspelledAs = (port: number, misspelling: Misspelling): string => {
	switch (misspelling) {
		case "a leading zero":
			return `0${port}`
		case "a sign":
			return `+${port}`
		case "a fraction":
			return `${port}.0`
		case "an exponent":
			return `${port}e0`
		case "no digits":
			return "port"
		case "the empty name":
			return ""
		case "past the last port":
			return `${65_536 + port}`
		case "port zero":
			return "0"
	}
}

/** Every misspelling, once each. */
export const misspellings = [
	"a leading zero",
	"a sign",
	"a fraction",
	"an exponent",
	"no digits",
	"the empty name",
	"past the last port",
	"port zero"
] as const satisfies ReadonlyArray<Misspelling>

/** A name: unset, any port, or a port misspelled each way. */
export const names: Gen<Name> = oneOf<Name>([
	() => ({ kind: "unset" }),
	(source) => ({ kind: "port", port: source.draw(int(1, 65_535)) }),
	(source) => {
		const misspelling = source.draw(element(misspellings))
		return {
			kind: "misspelled",
			text: misspelledAs(source.draw(int(1, 65_535)), misspelling),
			misspelling
		}
	}
])

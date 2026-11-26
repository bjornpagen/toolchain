import { Array as Arr, String as Str } from "effect"
import { refusal } from "#oxlint/rule.ts"

/**
 * The SQL that switches a table's triggers off, as words: `DISABLE TRIGGER`, of one trigger by its name, of the user's
 * or of all, and `session_replication_role`, under whose replica setting no ordinary trigger fires.
 */
export const TRIGGER_SWITCHES: ReadonlyArray<string> = [
	"disable trigger",
	"session_replication_role"
]

/** The blanks PostgreSQL reads between two words. */
const BLANKS: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", "\f"])

/** `text` as PostgreSQL reads its words: lower case, each run of blanks one space. */
const wordsOf = (text: string): string => {
	let out = ""
	let blank = false
	for (const ch of Str.toLowerCase(text)) {
		if (BLANKS.has(ch)) {
			blank = true
			continue
		}
		out += blank && out !== "" ? ` ${ch}` : ch
		blank = false
	}
	return out
}

/** Whether `text` holds a trigger switch, in any case and spacing. */
const switches = (text: string): boolean => {
	const words = wordsOf(text)
	return Arr.some(TRIGGER_SWITCHES, (phrase) => Str.includes(phrase)(words))
}

/**
 * SQL text in a test that switches triggers off: a string literal, or a template literal any of whose parts, between its
 * expressions, holds the switch. A test that writes rows with the triggers off writes a state no production path
 * reaches, rows no capture saw, no judge judged and no guard held, and its verdict speaks of that state alone. A
 * configuration exempts the one module that makes an operator's hand change a drift test reports, where one is.
 */
export const noTriggerSwitch = refusal(
	"triggerSwitch",
	"This switches triggers off, writing a state no production path reaches: rows no capture saw, no rule judged and no guard held. Write the rows through the program the test exercises, or commit them once into the test's template, judged at their COMMIT; lift a guard through the data-step bracket. An operator's hand change a drift test reports goes through its one constructor module.",
	(_context, refuse) => ({
		Literal: (node) => {
			if (typeof node.value === "string" && switches(node.value)) {
				refuse(node)
			}
		},
		TemplateLiteral: (node) => {
			if (Arr.some(node.quasis, (quasi) => switches(quasi.value.raw))) {
				refuse(node)
			}
		}
	})
)

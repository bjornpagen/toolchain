import { Array as Arr, Formatter, Option, Result } from "effect"
import { killApplied, killMissing } from "#mutants.ts"
import type { AnyNode, Context, Rule } from "#oxlint/rule.ts"
import { keyOf, propertiesNamed } from "#oxlint/syntax.ts"
import type { Kill } from "#property.ts"

/** The file system and paths, synchronously, as an oxlint rule reads: a rule's visitor is synchronous. */
const { existsSync, readFileSync } = process.getBuiltinModule("node:fs")
const { dirname, join, resolve } = process.getBuiltinModule("node:path")

/** The fields a kill states, each a string (property.ts Kill): an object literal holding all four is kill-shaped. */
const KILL_FIELDS = ["file", "original", "replacement", "why"] as const

/** The name a property's spec, or a constant it reads, holds its kills under. */
const KILLS_NAME = "kills"

/**
 * Whether a list holds a property's kills: the list a spec's `kills` field holds, the one a constant named `kills`
 * holds, or one passed to a call, a helper that makes a property and hands the list on as its kills. A kill-shaped
 * object anywhere else (a record of kills a test of the mutator draws from, a kill handed to killApplied) is the
 * test's data, never a kill of this repository's code.
 */
const holdsKills = (list: AnyNode): boolean =>
	Option.exists(
		Option.fromNullishOr(list.parent),
		(parent) =>
			(parent.type === "Property" && Option.contains(keyOf(parent), KILLS_NAME)) ||
			(parent.type === "VariableDeclarator" &&
				parent.id.type === "Identifier" &&
				parent.id.name === KILLS_NAME) ||
			(parent.type === "CallExpression" && Arr.contains(parent.arguments, list))
	)

/**
 * The string a node states literally: a string literal, or a template literal with no substitution, by its cooked
 * text; none for anything computed.
 */
const literalText = (node: AnyNode): Option.Option<string> => {
	if (node.type === "Literal") {
		return typeof node.value === "string" ? Option.some(node.value) : Option.none()
	}
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
		return Option.flatMap(Arr.head(node.quasis), (quasi) =>
			Option.fromNullishOr(quasi.value.cooked)
		)
	}
	return Option.none()
}

/**
 * The checkout a test module lies in, which a kill's file is relative to: the nearest directory at or above the
 * module's that holds `.git`, as the mutator finds a package's (mutate/commands.ts checkoutOf); none outside one.
 */
const checkoutAbove = (file: string): Option.Option<string> => {
	let at = dirname(resolve(file))
	for (;;) {
		if (existsSync(join(at, ".git"))) {
			return Option.some(at)
		}
		const up = dirname(at)
		if (up === at) {
			return Option.none()
		}
		at = up
	}
}

/** A kill's file's text in the checkout, none where the checkout holds no such file. */
const textIn = (checkout: string, file: string): Option.Option<string> => {
	const target = join(checkout, file)
	return existsSync(target) ? Option.some(readFileSync(target, "utf8")) : Option.none()
}

/** The kill an object literal states: all four fields, each a literal string, or none where one is computed. */
const killOf = (element: AnyNode): Option.Option<Kill> => {
	const field = (name: (typeof KILL_FIELDS)[number]): Option.Option<string> =>
		Option.flatMap(Arr.head(propertiesNamed(element, name)), (property) =>
			literalText(property.value)
		)
	return Option.all({
		file: field("file"),
		original: field("original"),
		replacement: field("replacement"),
		why: field("why")
	})
}

/** Whether an object literal states every field of a kill, literally or not: what the rule judges. */
const isKillShaped = (element: AnyNode): boolean =>
	Arr.every(KILL_FIELDS, (field) => Arr.isReadonlyArrayNonEmpty(propertiesNamed(element, field)))

/**
 * A kill (a kill-shaped object in a list that holds a property's kills, holdsKills) whose original does not stand
 * exactly once in its file, the checkout's text of it read as the mutator reads
 * it (mutants.ts killApplied, the one judgement of a stale kill): a mutation run would find it stale, so the check
 * refuses it where it is written, naming the test it sits in, the file and the text. A kill states its fields as
 * literal strings, so its file and original are read without running the test; one computed is refused too. This rule
 * alone of the plugin reads files beside the module it lints: the files its kills name.
 */
export const noStaleKill: Rule = {
	meta: {
		type: "problem",
		messages: {
			stale:
				"{{why}}: {{original}}. Point the kill's original at the code where it moved, or delete the kill where that code is gone.",
			computed:
				"A kill states its file, original, replacement and why as literal strings, so the check reads its file and original without running the test."
		}
	},
	create: (context: Context) => ({
		ObjectExpression: (element) => {
			if (
				!isKillShaped(element) ||
				element.parent.type !== "ArrayExpression" ||
				!holdsKills(element.parent)
			) {
				return
			}
			const kill = killOf(element)
			if (Option.isNone(kill)) {
				context.report({ node: element, messageId: "computed" })
				return
			}
			const judged = Option.map(checkoutAbove(context.physicalFilename), (checkout) =>
				Option.match(textIn(checkout, kill.value.file), {
					onNone: () => Result.fail(killMissing(kill.value)),
					onSome: (text) => killApplied(kill.value, text)
				})
			)
			if (Option.isSome(judged) && Result.isFailure(judged.value)) {
				context.report({
					node: element,
					messageId: "stale",
					data: {
						why: judged.value.failure.message,
						original: Formatter.format(kill.value.original)
					}
				})
			}
		}
	})
}

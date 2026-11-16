import { Array as Arr, Option } from "effect"
import type { AnyNode, Context, NodeOf, Rule } from "#oxlint/rule.ts"
import { keyOf } from "#oxlint/syntax.ts"

/** The option that states how many cases, effects or elements run at once. */
export const CONCURRENCY = "concurrency"

/** The width every search and every Effect collection already runs at where its options state none: one at a time. */
export const DEFAULT_WIDTH = 1

type Fixer = Parameters<NonNullable<Parameters<Context["report"]>[0]["fix"]>>[0]
type Fix = ReturnType<Fixer["remove"]>

/** `concurrency: 1`, the width every search and Effect collection already runs at, written out. */
const isRestated = (property: AnyNode): boolean =>
	property.type === "Property" &&
	Option.contains(keyOf(property), CONCURRENCY) &&
	property.value.type === "Literal" &&
	property.value.value === DEFAULT_WIDTH

/**
 * The text that removing a property deletes: the property and the comma that parts it from its neighbour (the next
 * one's, else the previous one's), so the neighbours keep their layout; an object of this one property alone, handed
 * to a call after another argument, goes whole with the comma before it.
 */
const removal = (
	fixer: Fixer,
	object: NodeOf<"ObjectExpression">,
	property: AnyNode,
	at: number
): Fix => {
	const next = object.properties[at + 1]
	if (next !== undefined) {
		return fixer.replaceTextRange([property.range[0], next.range[0]], "")
	}
	const previous = object.properties[at - 1]
	if (previous !== undefined) {
		return fixer.replaceTextRange([previous.range[1], property.range[1]], "")
	}
	const call = object.parent
	if (
		call.type === "CallExpression" &&
		Option.exists(Arr.last(call.arguments), (last) => last === object)
	) {
		const before = call.arguments[call.arguments.length - 2]
		if (before !== undefined) {
			return fixer.replaceTextRange([before.range[1], object.range[1]], "")
		}
	}
	return fixer.remove(property)
}

/**
 * Restated concurrency: `concurrency: 1` in any object a test, its support or its harness writes, a search's spec or
 * an Effect collection's options. One at a time is already the width each runs at where its options state none, so
 * the option only restates it, and a case's parallelism is the runner's, never a spec's. The fix deletes the option;
 * an options object it leaves empty as a call's last argument goes with it.
 */
export const noRestatedConcurrency: Rule = {
	meta: {
		type: "problem",
		fixable: "code",
		messages: {
			restatedConcurrency:
				"`concurrency: 1` restates the width a search and an Effect collection already run at, and asks for serial execution the runner owns. Delete it."
		}
	},
	create: (context) => ({
		ObjectExpression: (object) => {
			Arr.forEach(object.properties, (property, at) => {
				if (isRestated(property)) {
					context.report({
						node: property,
						messageId: "restatedConcurrency",
						fix: (fixer) => removal(fixer, object, property, at)
					})
				}
			})
		}
	})
}

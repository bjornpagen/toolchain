/**
 * The no-variadic-callback rule (src/oxlint/rules/no-variadic-callback.ts), over a box of calls: each callee that
 * passes its callback more than the element (an array's reduce and map, Effect's Arr.reduce, a namespace import of
 * effect/Array, a function imported from it, a method of a passing name on another receiver, Option.map) or exactly its
 * arguments (a function of the module's), handed a builtin that reads past its first argument (Math.max,
 * Number.parseInt, parseInt, String.fromCharCode) or one that reads one (Math.abs), the builtin's holder a global or
 * shadowed by a parameter. Every case carries the reports the contract gives it, one where a passing callee is handed a
 * reading builtin no binding shadows and none else, and oxlint's RuleTester, run in the case, must find exactly that
 * many.
 *
 * Oracle: the specification, the rule's JSDoc read over the box. Features: a passing callee handed a reading builtin,
 * a callee passing exactly its arguments, a builtin of one argument, a shadowed holder.
 */
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import { callCases, featuresOf, judged } from "#oxlint/rules/no-variadic-callback.fixtures.ts"

/** Reports exactly the builtins that read past their first argument handed to a callee that passes more. */
export const variadicCallbacks = property.exhaust(finite(callCases), {
	needs: {},
	situations: [
		"a passing callee handed a reading builtin",
		"a callee passing exactly its arguments",
		"a builtin of one argument",
		"a shadowed holder"
	],
	check: (_resources, c) => (call) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(call))
			assert.deepEqual(judged(call), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over a box of callees and builtins"
	},
	box: "each callee passing more than the element or exactly its arguments, each builtin reading past its first argument or not, its holder global or shadowed",
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/oxlint/rules/no-variadic-callback.ts",
			original: '\t"reduce",\n',
			replacement: "",
			why: "An array's reduce is read as a callee passing exactly its arguments: `xs.reduce(Math.max, 0)` folds each index into the maximum unreported."
		},
		{
			file: "packages/devtools/src/oxlint/rules/no-variadic-callback.ts",
			original: '\tif (module === "effect/Array") {\n\t\treturn true\n\t}\n',
			replacement: "",
			why: "A namespace import of effect/Array and a function imported from it are no Effect Array to the rule: `A.map(xs, Math.max)` and `reduce(xs, 0, Math.max)` pass unreported."
		},
		{
			file: "packages/devtools/src/oxlint/rules/no-variadic-callback.ts",
			original: "\tdefinitionsOf(context, identifier).length === 0\n",
			replacement: "\ttrue\n",
			why: "A holder a parameter shadows is read as the global (isGlobal): a local `Math` whose max reads one argument is reported."
		}
	]
})

import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, type NodeOf, problem } from "#oxlint/rule.ts"

const MESSAGE =
	"A builtin that reads more than its first argument is handed as a callback, so it takes every argument the callee passes: Array.prototype.reduce and Effect's Arr.reduce pass the index after the element, so Math.min(least, x, index) folds the index in, and map passes (value, index), so parseInt(value, index) reads the index as its radix. Write the callback as a lambda of exactly the arguments it means: (least, x) => Math.min(least, x), (text) => Number.parseInt(text, 10)."

/**
 * The builtins that read past their first argument, by the global that holds each: the variadic ones (Math.min,
 * Math.max, Math.hypot, String.fromCharCode, String.fromCodePoint, String.raw, Array.of, Date.UTC, Object.assign), and
 * those whose second parameter changes the answer (Math.atan2, Math.pow, Math.imul, Array.from's map function,
 * Number.parseInt's radix). A builtin of one parameter ignores what a callee passes beside it, so it passes.
 */
const READS_PAST_FIRST: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	["Math", ["min", "max", "hypot", "atan2", "pow", "imul"]],
	["String", ["fromCharCode", "fromCodePoint", "raw"]],
	["Array", ["of", "from"]],
	["Number", ["parseInt"]],
	["Date", ["UTC"]],
	["Object", ["assign"]]
])

/** The global functions that read past their first argument: parseInt, whose second is its radix. */
const GLOBAL_READS_PAST_FIRST: ReadonlyArray<string> = ["parseInt"]

/**
 * The methods that call their callback with more than the element, whatever their receiver: an array's, a typed
 * array's, a set's or a map's iteration (the element, then its index or key, then the collection), reduce's (the
 * accumulator, the element, its index, the array), a sort's comparator (two elements), and Array.from's map function
 * (the element, its index). The syntax shows no receiver's type, so a method of one of these names on any receiver is
 * read alike, Effect's Option.map, which passes the value alone, among them: a lambda costs it nothing.
 */
const PASSING_METHODS: ReadonlyArray<string> = [
	"map",
	"flatMap",
	"forEach",
	"filter",
	"reduce",
	"reduceRight",
	"some",
	"every",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"sort",
	"toSorted",
	"from"
]

type Scope = ReturnType<Context["sourceCode"]["getScope"]>

type Definition = Scope["variables"][number]["defs"][number]

/** The definitions of the variable an identifier names where it stands; none for a global. */
const definitionsOf = (
	context: Context,
	identifier: NodeOf<"Identifier">
): ReadonlyArray<Definition> => {
	for (
		let scope: Scope | null = context.sourceCode.getScope(identifier);
		scope !== null;
		scope = scope.upper
	) {
		const found = scope.set.get(identifier.name)
		if (found !== undefined) {
			return found.defs
		}
	}
	return []
}

/**
 * Whether an import binding is Effect's Array module or one of its functions: `Array` imported from "effect" (under any
 * local name), a namespace import of "effect/Array", or a function imported by name from "effect/Array". Every function
 * of the module that takes a callback passes it the element's index beside the element (Arr.map, Arr.reduce, Arr.filter
 * and the rest), so any callback handed to one may be handed more than the element.
 */
const isEffectArray = (definition: Definition): boolean => {
	const { node, parent } = definition
	if (definition.type !== "ImportBinding" || parent?.type !== "ImportDeclaration") {
		return false
	}
	const module = parent.source.value
	if (module === "effect/Array") {
		return true
	}
	if (module !== "effect" || node.type !== "ImportSpecifier") {
		return false
	}
	const { imported } = node
	return (imported.type === "Identifier" ? imported.name : imported.value) === "Array"
}

/** Whether an identifier names Effect's Array module or one of its functions where it stands (`isEffectArray`). */
const namesEffectArray = (context: Context, identifier: NodeOf<"Identifier">): boolean => {
	const definitions = definitionsOf(context, identifier)
	return Arr.isReadonlyArrayNonEmpty(definitions) && Arr.every(definitions, isEffectArray)
}

/**
 * Whether a call's callee hands its callback more than the element: a method of PASSING_METHODS on any receiver, or a
 * function of Effect's Array module, reached off its import (`Arr.reduce`) or imported by name (`reduce`).
 */
const passesExtraArguments = (context: Context, call: NodeOf<"CallExpression">): boolean => {
	const { callee } = call
	if (callee.type === "Identifier") {
		return namesEffectArray(context, callee)
	}
	if (
		callee.type !== "MemberExpression" ||
		callee.computed ||
		callee.property.type !== "Identifier"
	) {
		return false
	}
	return (
		Arr.contains(PASSING_METHODS, callee.property.name) ||
		(callee.object.type === "Identifier" && namesEffectArray(context, callee.object))
	)
}

/**
 * Whether an identifier names the global of its name where it stands: no binding of the file declares it, an
 * environment's global (a variable of no definition) or one no environment declares alike, so the rule reads a
 * builtin whatever globals the configuration declares.
 */
const isGlobal = (context: Context, identifier: NodeOf<"Identifier">): boolean =>
	definitionsOf(context, identifier).length === 0

/** The builtin an argument names, where it names one that reads past its first argument and no binding shadows it. */
const builtinOf = (context: Context, argument: AnyNode): Option.Option<string> => {
	if (argument.type === "Identifier") {
		return Arr.contains(GLOBAL_READS_PAST_FIRST, argument.name) && isGlobal(context, argument)
			? Option.some(argument.name)
			: Option.none()
	}
	if (
		argument.type !== "MemberExpression" ||
		argument.computed ||
		argument.object.type !== "Identifier" ||
		argument.property.type !== "Identifier"
	) {
		return Option.none()
	}
	const holder = argument.object
	const property = argument.property.name
	return Arr.contains(READS_PAST_FIRST.get(holder.name) ?? [], property) &&
		isGlobal(context, holder)
		? Option.some(`${holder.name}.${property}`)
		: Option.none()
}

/**
 * No builtin that reads past its first argument (READS_PAST_FIRST, GLOBAL_READS_PAST_FIRST) is handed as a callback to
 * a callee that passes its callback more than the element (PASSING_METHODS, Effect's Array module): it takes the
 * index, the key or the collection as its next argument, so `Arr.reduce(xs, Infinity, Math.min)` folds each index into
 * the minimum and `texts.map(Number.parseInt)` parses each text in the radix of its index. A lambda states the
 * arguments it means.
 */
export const noVariadicCallback = problem((context) => ({
	CallExpression: (node) => {
		if (!passesExtraArguments(context, node)) {
			return
		}
		for (const argument of node.arguments) {
			if (Option.isSome(builtinOf(context, argument))) {
				context.report({ node: argument, message: MESSAGE })
			}
		}
	}
}))

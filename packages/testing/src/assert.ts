import { AssertionError } from "node:assert"
import strict from "node:assert/strict"
import { inspect, isDeepStrictEqual } from "node:util"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"

export { AssertionError } from "node:assert"

/**
 * The assert door: the one module a property's check asserts through, and the one door to node:assert. Every equality
 * types its expected value by the actual one: `expected` is `NoInfer<T>`, with T bound by `actual`, so a literal that
 * drifted from the type it states is a compile error, never a run-time mismatch. A reason is a trailing tuple, never an
 * optional parameter. A failed assertion throws node's AssertionError: a defect, which falsifies the case it ran in.
 *
 * `assert` holds node:assert/strict's assertions, each delegating to it with that typing: ok, equal, notEqual,
 * deepEqual, notDeepEqual, match, doesNotMatch, throws (by a predicate or a class), throwsAny, rejects and fail.
 * Beside it:
 * - `contains` and `lacks`: an element of an array or a set by identity, or by a Matcher;
 * - `containsText` and `lacksText`: a substring of a text;
 * - `containsEqual`: an element of an iterable by deep equality;
 * - `matchesObject`: an object pattern, used in place of partialDeepStrictEqual, which compares prototypes and so
 *   never matches an Error or a class instance against a plain pattern, and which accepts any subsequence of an
 *   array where this matches arrays element for element and in length;
 * - `like`: deepStrictEqual with `matchers` patterns anywhere in the expected value;
 * - `unorderedEqual`: the same elements, each once, in any order (a set), where the order is unspecified;
 * - `defined` and `nonEmpty`: a value that is not undefined, a list that holds an element, returned narrowed;
 * - `assertVariant` and `assertNot`: a union narrowed to one variant by its tag, or past one value;
 * - `deepEquals`: deep strict equality as a typed predicate;
 * - `failureOf`: an Effect's failure, as its value;
 * - `assertionFailed`: a failed assertion of a repository's own, reported as these report theirs.
 *
 * Why an assertion holds, for its report: nothing, or one reason.
 */
export type Why = readonly [] | readonly [why: string]

export interface Assert {
	ok(value: unknown, ...why: Why): asserts value
	equal<T>(actual: T, expected: NoInfer<T>, ...why: Why): void
	notEqual<T>(actual: T, expected: NoInfer<T>, ...why: Why): void
	deepEqual<T>(actual: T, expected: NoInfer<T>, ...why: Why): void
	notDeepEqual<T>(actual: T, expected: NoInfer<T>, ...why: Why): void
	match(actual: string, expected: RegExp, ...why: Why): void
	doesNotMatch(actual: string, expected: RegExp, ...why: Why): void
	throws(
		block: () => unknown,
		expected: ((error: unknown) => boolean) | (abstract new (...args: never) => unknown),
		...why: Why
	): void
	throwsAny(block: () => unknown, ...why: Why): void
	rejects(
		block: () => Promise<unknown>,
		expected: ((error: unknown) => boolean) | (abstract new (...args: never) => unknown),
		...why: Why
	): Promise<void>
	fail(why: string): never
}

/**
 * Node's equality and match assertions are overloaded on their message and refuse an undefined one, so each member
 * passes `why` as it was given: no reason is no argument.
 */
export const assert: Assert = {
	ok: (value, ...why) => {
		if (why.length === 0) {
			strict.ok(Boolean(value))
		} else {
			strict.ok(Boolean(value), why[0])
		}
	},
	equal: (actual, expected, ...why) => {
		if (why.length === 0) {
			strict.equal(actual, expected)
		} else {
			strict.equal(actual, expected, why[0])
		}
	},
	notEqual: (actual, expected, ...why) => {
		if (why.length === 0) {
			strict.notEqual(actual, expected)
		} else {
			strict.notEqual(actual, expected, why[0])
		}
	},
	deepEqual: (actual, expected, ...why) => {
		if (why.length === 0) {
			strict.deepEqual(actual, expected)
		} else {
			strict.deepEqual(actual, expected, why[0])
		}
	},
	notDeepEqual: (actual, expected, ...why) => {
		if (why.length === 0) {
			strict.notDeepEqual(actual, expected)
		} else {
			strict.notDeepEqual(actual, expected, why[0])
		}
	},
	match: (actual, expected, ...why) => {
		if (why.length === 0) {
			strict.match(actual, expected)
		} else {
			strict.match(actual, expected, why[0])
		}
	},
	doesNotMatch: (actual, expected, ...why) => {
		if (why.length === 0) {
			strict.doesNotMatch(actual, expected)
		} else {
			strict.doesNotMatch(actual, expected, why[0])
		}
	},
	throws: (block, expected, ...why) => {
		strict.throws(block, expected, ...why)
	},
	/** A validation function that accepts any thrown value: the block throwing is the assertion. */
	throwsAny: (block, ...why) => {
		strict.throws(block, () => true, ...why)
	},
	rejects: (block, expected, ...why) => strict.rejects(block, expected, ...why),
	fail: (why) => strict.fail(why)
}

/**
 * A value as the list it is: Array.isArray narrows `unknown` to `any[]`, which would let an untyped element flow on;
 * this narrows it to a list of unknown elements, each of which its reader then checks.
 */
const isList = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

/**
 * A pattern that stands for every value it accepts, inside an expected value of `like`, `matchesObject`, `contains`,
 * `lacks` or `containsEqual`. Its values come only from `matchers`.
 */
class Matcher {
	readonly description: string
	readonly test: (value: unknown) => boolean
	constructor(description: string, test: (value: unknown) => boolean) {
		this.description = description
		this.test = test
	}
	[inspect.custom](): string {
		return this.description
	}
}

export type { Matcher }

/** An expected value at the actual value's type, with a Matcher allowed in place of any part of it. */
export type Pattern<T> =
	| Matcher
	| (T extends ReadonlyArray<infer E>
			? ReadonlyArray<Pattern<E>>
			: T extends object
				? { readonly [K in keyof T]: Pattern<T[K]> }
				: T)

/**
 * A Pattern whose object fields may each be left out: `matchesObject` compares only the fields the pattern names. An
 * Option is matched as an Option, Option.some(pattern) or Option.none(): mapped as an object, every field of an Option
 * would be optional, and a plain value such as a string would pass for one.
 */
export type PartialPattern<T> =
	| Matcher
	| ([T] extends [Option.Option<infer A>]
			? Option.Option<PartialPattern<A>>
			: T extends ReadonlyArray<infer E>
				? ReadonlyArray<PartialPattern<E>>
				: T extends object
					? { readonly [K in keyof T]?: PartialPattern<T[K]> }
					: T)

const isMatcher = (value: unknown): value is Matcher => value instanceof Matcher

/**
 * Every property of a non-null object reads as some value, which `unknown` describes, so this claims no more than it
 * checks.
 */
const isKeyed = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
	value !== null && typeof value === "object"

/**
 * Whether `expected` holds a Matcher anywhere; without one, `like` is exactly deepStrictEqual. `seen` holds the
 * objects already walked, so a cycle ends.
 */
const hasMatcher = (expected: unknown, seen: Set<object>): boolean => {
	if (isMatcher(expected)) {
		return true
	}
	if (expected === null || typeof expected !== "object" || seen.has(expected)) {
		return false
	}
	seen.add(expected)
	return Arr.some(Rec.values(expected), (value) => hasMatcher(value, seen))
}

/**
 * An object `matchesObject` compares by its own keys, whatever its class: anything but an Error, a Date, a RegExp, a
 * Map, a Set, a typed array or a boxed primitive, which have state besides their keys and are compared whole.
 */
const isPattern = (value: unknown): value is Record<PropertyKey, unknown> =>
	value !== null &&
	typeof value === "object" &&
	!(value instanceof Error) &&
	!(value instanceof Date) &&
	!(value instanceof RegExp) &&
	!(value instanceof Map) &&
	!(value instanceof Set) &&
	!ArrayBuffer.isView(value) &&
	!(value instanceof String || value instanceof Number || value instanceof Boolean)

const ownKeys = (value: object): Array<PropertyKey> =>
	Arr.filter(Reflect.ownKeys(value), (key) =>
		Object.prototype.propertyIsEnumerable.call(value, key)
	)

/**
 * Equality under `like` (partial = false) and `matchesObject` (partial = true). Without a Matcher, a full comparison
 * is deepStrictEqual; a partial one compares only the pattern's own keys, recursively, ignoring prototypes
 * (so a class instance such as a Result is a pattern too), and arrays element for element and in length. An Option
 * pattern agrees only with an Option of its own case, a Some by its value: Option.none() has no own key, so compared by
 * its keys it would agree with anything.
 */
const agrees = (actual: unknown, pattern: unknown, partial: boolean): boolean => {
	if (isMatcher(pattern)) {
		return pattern.test(actual)
	}
	if (Option.isOption(pattern)) {
		return (
			Option.isOption(actual) &&
			(Option.isNone(pattern)
				? Option.isNone(actual)
				: Option.isSome(actual) && agrees(actual.value, pattern.value, partial))
		)
	}
	if (!partial && !hasMatcher(pattern, new Set())) {
		return isDeepStrictEqual(actual, pattern)
	}
	if (isList(pattern)) {
		return (
			isList(actual) &&
			actual.length === pattern.length &&
			Arr.every(pattern, (item, index) => agrees(actual[index], item, partial))
		)
	}
	if (
		pattern === null ||
		typeof pattern !== "object" ||
		(partial && !isPattern(pattern) && !hasMatcher(pattern, new Set()))
	) {
		return isDeepStrictEqual(actual, pattern)
	}
	if (!isKeyed(actual) || !isKeyed(pattern)) {
		return false
	}
	if (!partial && Object.getPrototypeOf(actual) !== Object.getPrototypeOf(pattern)) {
		return false
	}
	const keys = ownKeys(pattern)
	if (!partial && ownKeys(actual).length !== keys.length) {
		return false
	}
	return Arr.every(keys, (key) => key in actual && agrees(actual[key], pattern[key], partial))
}

export const matchers = {
	/**
	 * Any value of the class, or for a primitive class (String, Number, BigInt, Boolean, Symbol, Function, Object)
	 * any value of that type, boxed or not.
	 */
	any: (
		type: (abstract new (...args: never) => unknown) | BigIntConstructor | SymbolConstructor
	): Matcher =>
		new Matcher(`matchers.any(${type.name})`, (value) => {
			if (type === String) {
				return typeof value === "string" || value instanceof String
			}
			if (type === Number) {
				return typeof value === "number" || value instanceof Number
			}
			if (type === BigInt) {
				return typeof value === "bigint"
			}
			if (type === Boolean) {
				return typeof value === "boolean" || value instanceof Boolean
			}
			if (type === Symbol) {
				return typeof value === "symbol"
			}
			if (type === Function) {
				return typeof value === "function"
			}
			if (type === Object) {
				return typeof value === "object" && value !== null
			}
			return type !== BigInt && type !== Symbol && value instanceof type
		}),
	/** Any value but null and undefined. */
	anything: (): Matcher =>
		new Matcher("matchers.anything()", (value) => value !== null && value !== undefined),
	/** An array holding, for each expected element, some element equal to it under `like`, in any order. */
	arrayContaining: (expected: ReadonlyArray<unknown>): Matcher =>
		new Matcher(
			`matchers.arrayContaining(${inspect(expected)})`,
			(value) =>
				isList(value) &&
				Arr.every(expected, (item) =>
					Arr.some(value, (candidate) => agrees(candidate, item, false))
				)
		),
	/** An object with at least the expected properties, each equal under `like`. */
	objectContaining: (expected: Readonly<Record<string, unknown>>): Matcher =>
		new Matcher(
			`matchers.objectContaining(${inspect(expected)})`,
			(value) =>
				isKeyed(value) &&
				Arr.every(
					Rec.toEntries(expected),
					([key, item]) => key in value && agrees(value[key], item, false)
				)
		),
	stringContaining: (expected: string): Matcher =>
		new Matcher(
			`matchers.stringContaining(${inspect(expected)})`,
			(value) => typeof value === "string" && Str.includes(expected)(value)
		),
	stringMatching: (expected: RegExp | string): Matcher =>
		new Matcher(
			`matchers.stringMatching(${inspect(expected)})`,
			(value) =>
				typeof value === "string" &&
				(typeof expected === "string" ? Str.includes(expected)(value) : expected.test(value))
		)
} as const

/**
 * Fails the assertion `operator`: its report is the caller's reason when one is given, and otherwise the assertion's own,
 * what it expected, with both values. A repository's own assertions (grizzle's refusals) fail through it, so every
 * failed assertion reports alike.
 */
export const assertionFailed = (
	why: Why,
	actual: unknown,
	wanted: unknown,
	operator: string,
	what: string
): never => {
	throw new AssertionError({
		message:
			why.length === 0
				? `${what}\n\nactual: ${inspect(actual, { depth: 8 })}\nexpected: ${inspect(wanted, { depth: 8 })}`
				: why[0],
		actual,
		expected: wanted,
		operator
	})
}

/** Whether the collection holds `needle`: an element identical to it (===), or one the Matcher accepts. */
const found = <T>(haystack: ReadonlyArray<T> | ReadonlySet<T>, needle: T | Matcher): boolean => {
	for (const item of haystack) {
		if (isMatcher(needle) ? needle.test(item) : item === needle) {
			return true
		}
	}
	return false
}

/** `haystack` holds `needle`, by identity (===) or by a Matcher. */
export function contains<T>(
	haystack: ReadonlyArray<T> | ReadonlySet<T>,
	needle: NoInfer<T> | Matcher,
	...why: Why
): void {
	if (!found(haystack, needle)) {
		assertionFailed(
			why,
			haystack,
			needle,
			"contains",
			"Expected the collection to contain the needle."
		)
	}
}

/** `haystack` does not hold `needle`, in the sense of `contains`. */
export function lacks<T>(
	haystack: ReadonlyArray<T> | ReadonlySet<T>,
	needle: NoInfer<T> | Matcher,
	...why: Why
): void {
	if (found(haystack, needle)) {
		assertionFailed(
			why,
			haystack,
			needle,
			"lacks",
			"Expected the collection not to contain the needle."
		)
	}
}

/** `haystack` has an element deep-equal to `needle` (patterns allowed, as in `like`). */
export function containsEqual<T>(
	haystack: Iterable<T>,
	needle: Pattern<NoInfer<T>>,
	...why: Why
): void {
	for (const item of haystack) {
		if (agrees(item, needle, false)) {
			return
		}
	}
	assertionFailed(
		why,
		haystack,
		needle,
		"containsEqual",
		"Expected the value to contain an element equal to the needle."
	)
}

/** The text `haystack` holds `needle` as a substring. */
export function containsText(haystack: string, needle: string, ...why: Why): void {
	if (!Str.includes(needle)(haystack)) {
		assertionFailed(
			why,
			haystack,
			needle,
			"containsText",
			"Expected the text to contain the needle."
		)
	}
}

/** The text `haystack` does not hold `needle` as a substring. */
export function lacksText(haystack: string, needle: string, ...why: Why): void {
	if (Str.includes(needle)(haystack)) {
		assertionFailed(
			why,
			haystack,
			needle,
			"lacksText",
			"Expected the text not to contain the needle."
		)
	}
}

/** `value` itself when it is not undefined; otherwise the assertion fails. It narrows a lookup that may miss. */
export function defined<T>(value: T | undefined, ...why: Why): T {
	if (value === undefined) {
		return assertionFailed(why, value, "a value", "defined", "Expected a value, got undefined.")
	}
	return value
}

/** `items` itself when it holds an element; otherwise the assertion fails. It narrows a list the test knows nonempty. */
export function nonEmpty<A>(items: ReadonlyArray<A>, ...why: Why): Arr.NonEmptyReadonlyArray<A> {
	if (!Arr.isReadonlyArrayNonEmpty(items)) {
		return assertionFailed(
			why,
			items,
			"a nonempty list",
			"nonEmpty",
			"Expected a nonempty list, got an empty one."
		)
	}
	return items
}

/**
 * Narrows `value` to the variant whose `field` holds `tag`, as `assert.ok(value.kind === "x")` would, but a value of
 * another variant fails naming the variant it is rather than only "expected true".
 */
export function assertVariant<T, K extends keyof T, const V extends T[K]>(
	value: T,
	field: K,
	tag: V,
	...why: Why
): asserts value is Extract<T, Readonly<Record<K, V>>> {
	if (value[field] !== tag) {
		assertionFailed(
			why,
			value[field],
			tag,
			"assertVariant",
			`Expected ${String(field)} ${String(tag)}, got: ${String(value[field])}`
		)
	}
}

/** Whether two values of one type are deeply and strictly equal, as `assert.deepEqual` judges them: the typed predicate. */
export const deepEquals = <T>(actual: T, expected: NoInfer<T>): boolean =>
	isDeepStrictEqual(actual, expected)

/** Narrows `value` past `excluded`, as `assert.ok(value !== excluded)` would, but failing names the value it met. */
export function assertNot<T, const V extends T>(
	value: T,
	excluded: V,
	...why: Why
): asserts value is Exclude<T, V> {
	if (value === excluded) {
		assertionFailed(
			why,
			value,
			`anything but ${String(excluded)}`,
			"assertNot",
			`Expected anything but ${String(excluded)}`
		)
	}
}

/** The failure of an effect that must fail, as its value; a success is a defect that names it. */
export const failureOf = <E, R>(effect: Effect.Effect<unknown, E, R>): Effect.Effect<E, never, R> =>
	Effect.matchEffect(effect, {
		onFailure: Effect.succeed,
		onSuccess: (value) =>
			Effect.die(new Error(`expected a failure, got a success: ${inspect(value, { depth: 4 })}`))
	})

/**
 * `actual` holds the elements of `expected`, each once, in any order: equality of sets, each element compared as
 * deepStrictEqual compares, where neither side holds an element twice, since an answer that repeats an element is no
 * set and a repeat is never folded away. It states an unordered result's contract, where sorting both sides would order
 * objects by their text and compare an order the contract leaves open. Matching is greedy, which is exact for an
 * equivalence relation.
 */
export function unorderedEqual<T>(
	actual: ReadonlyArray<T>,
	expected: ReadonlyArray<NoInfer<T>>,
	...why: Why
): void {
	for (const [side, elements] of [
		["actual", actual],
		["expected", expected]
	] as const) {
		const repeated = Arr.findFirst(elements, (element, at) =>
			Arr.some(Arr.drop(elements, at + 1), (later) => isDeepStrictEqual(element, later))
		)
		if (Option.isSome(repeated)) {
			assertionFailed(
				why,
				actual,
				expected,
				"unorderedEqual",
				`Expected each element once, in any order: the ${side} side holds ${inspect(repeated.value, { depth: 8 })} more than once.`
			)
		}
	}
	const unmatched = [...expected]
	const extra: Array<T> = []
	for (const element of actual) {
		const at = Arr.findFirstIndex(unmatched, (wanted) => isDeepStrictEqual(element, wanted))
		if (Option.isNone(at)) {
			extra.push(element)
		} else {
			unmatched.splice(at.value, 1)
		}
	}
	if (extra.length > 0 || unmatched.length > 0) {
		assertionFailed(
			why,
			actual,
			expected,
			"unorderedEqual",
			`Expected the same elements, each once, in any order.\n\nextra: ${inspect(extra, { depth: 8 })}\nmissing: ${inspect(unmatched, { depth: 8 })}`
		)
	}
}

/** deepStrictEqual, with `matchers` patterns standing for the values they accept. */
export function like<T>(actual: T, expected: Pattern<NoInfer<T>>, ...why: Why): void {
	if (!agrees(actual, expected, false)) {
		assertionFailed(why, actual, expected, "like", "Expected the values to be alike.")
	}
}

/**
 * Every property of the expected object is in `actual` and matches, recursively; arrays
 * match element for element and have the same length; patterns allowed, as in `like`.
 */
export function matchesObject<T>(
	actual: T,
	expected: PartialPattern<NoInfer<T>>,
	...why: Why
): void {
	if (!agrees(actual, expected, true)) {
		assertionFailed(
			why,
			actual,
			expected,
			"matchesObject",
			"Expected the value to match the object."
		)
	}
}

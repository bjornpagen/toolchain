import * as nodeAssert from "node:assert/strict"
import { isDeepStrictEqual } from "node:util"
import {
	Array as Arr,
	Equal,
	Exit,
	Formatter,
	Option,
	Predicate,
	Result,
	String as Str
} from "effect"

/**
 * The assert door: the one module a property's check asserts through, so no test module imports a runner's
 * assertions. Its functions are @effect/vitest/utils's, with the same names and signatures, and its `assert` is the
 * part of Vitest's chai `assert` the repositories use, so a conversion renames the import's specifier and nothing else.
 * Every assertion is built on node:assert/strict and Effect's equality, and a failed one throws node's AssertionError:
 * a defect, which falsifies the case it ran in.
 */

/** A class a value may be an instance of. */
type Constructor = abstract new (...args: never) => unknown

/** The instance of a class. */
type InstanceOf<C extends Constructor> = C extends abstract new (...args: never) => infer I
	? I
	: never

/** A sized collection, as `lengthOf` measures it: by its length, or a set's or map's size. */
type Sized = Readonly<{ length: number }> | ReadonlySet<unknown> | ReadonlyMap<unknown, unknown>

/**
 * Runs a node assertion with the message given, or with none: node:assert refuses a message given as undefined, and
 * with none it reports the difference under its own header.
 */
const judge = (
	message: string | undefined,
	bare: () => void,
	said: (message: string) => void
): void => {
	if (message === undefined) {
		bare()
	} else {
		said(message)
	}
}

/** Fails the case with `message`. */
export const fail = (message: string): never => nodeAssert.fail(message)

/** `actual` is deeply and strictly equal to `expected` (node's deepStrictEqual). */
export const deepStrictEqual = <A>(actual: A, expected: A, message?: string): void =>
	judge(
		message,
		() => nodeAssert.deepStrictEqual(actual, expected),
		(said) => nodeAssert.deepStrictEqual(actual, expected, said)
	)

/** `actual` is `expected` (node's strictEqual, Object.is). */
export const strictEqual = <A>(actual: A, expected: A, message?: string): void =>
	judge(
		message,
		() => nodeAssert.strictEqual(actual, expected),
		(said) => nodeAssert.strictEqual(actual, expected, said)
	)

/** `actual` equals `expected` by Effect's Equal.equals; the difference is shown as node's deep comparison shows it. */
export const assertEquals = <A>(actual: A, expected: A, message?: string): void => {
	if (!Equal.equals(actual, expected)) {
		judge(
			message,
			() => nodeAssert.deepStrictEqual(actual, expected),
			(said) => nodeAssert.deepStrictEqual(actual, expected, said)
		)
		nodeAssert.fail(message ?? "Expected values to be Equal.equals")
	}
}

/** `value` is an instance of `constructor`. */
export const assertInstanceOf: <C extends Constructor>(
	value: unknown,
	constructor: C,
	message?: string
) => asserts value is InstanceOf<C> = (value, constructor, message) => {
	if (!(value instanceof constructor)) {
		nodeAssert.fail(
			message ?? `Expected ${Formatter.format(value)} to be an instance of ${constructor.name}`
		)
	}
}

/** `self` is `true`. */
export const assertTrue: (self: unknown, message?: string) => asserts self = (self, message) =>
	judge(
		message,
		() => nodeAssert.strictEqual(self, true),
		(said) => nodeAssert.strictEqual(self, true, said)
	)

/** `self` is `false`. */
export const assertFalse = (self: boolean, message?: string): void =>
	judge(
		message,
		() => nodeAssert.strictEqual(self, false),
		(said) => nodeAssert.strictEqual(self, false, said)
	)

/** `actual` holds `expected`. */
export const assertInclude = (actual: string | undefined, expected: string): void => {
	if (actual === undefined || !Str.includes(expected)(actual)) {
		nodeAssert.fail(`Expected\n\n${String(actual)}\n\nto include\n\n${expected}`)
	}
}

/** `actual` matches `regExp`. */
export const assertMatch = (actual: string, regExp: RegExp): void => {
	if (!regExp.test(actual)) {
		nodeAssert.fail(`Expected\n\n${actual}\n\nto match\n\n${String(regExp)}`)
	}
}

/**
 * `thunk` throws; with `error`, what it throws is deeply equal to the error given, or passes the check given (a
 * function that throws when it does not).
 */
export const throws = (
	thunk: () => void,
	error?: Error | ((thrown: unknown) => undefined)
): void => {
	const thrown = Result.try(thunk)
	if (Result.isSuccess(thrown)) {
		return nodeAssert.fail("Expected to throw an error")
	}
	if (Predicate.isFunction(error)) {
		error(thrown.failure)
	} else if (error !== undefined) {
		nodeAssert.deepStrictEqual(thrown.failure, error)
	}
}

/** `option` is None. */
export const assertNone: <A>(option: Option.Option<A>) => asserts option is Option.None<never> = (
	option
) => nodeAssert.deepStrictEqual(option, Option.none())

/** `option` is Some of a value deeply equal to `expected`. */
export const assertSome: <A>(
	option: Option.Option<A>,
	expected: A
) => asserts option is Option.Some<A> = (option, expected) =>
	nodeAssert.deepStrictEqual(option, Option.some(expected))

/** `exit` succeeded with a value deeply equal to `expected`. */
export const assertExitSuccess: <A, E>(
	exit: Exit.Exit<A, E>,
	expected: A
) => asserts exit is Exit.Success<A> = (exit, expected) =>
	nodeAssert.deepStrictEqual(exit, Exit.succeed(expected))

/** Whether two lists hold the same members as multisets, each matched once, by `same`. */
const sameMembersBy = <A>(
	left: ReadonlyArray<A>,
	right: ReadonlyArray<A>,
	same: (one: A, other: A) => boolean
): boolean => {
	if (left.length !== right.length) {
		return false
	}
	const rest = Arr.copy(right)
	return Arr.every(left, (item) =>
		Option.match(
			Arr.findFirstIndex(rest, (other) => same(item, other)),
			{
				onNone: () => false,
				onSome: (at) => {
					rest.splice(at, 1)
					return true
				}
			}
		)
	)
}

/** Whether every member of `subset` is a member of `superset`, by `same`. */
const includesMembersBy = <A>(
	superset: ReadonlyArray<A>,
	subset: ReadonlyArray<A>,
	same: (one: A, other: A) => boolean
): boolean => Arr.every(subset, (item) => Arr.some(superset, (other) => same(item, other)))

/** `actual` and `expected` hold the same members, in any order, each as often (strict equality). */
export const assertSameMembers = <A>(
	actual: ReadonlyArray<A>,
	expected: ReadonlyArray<A>,
	message?: string
): void => {
	if (!sameMembersBy(actual, expected, Object.is)) {
		nodeAssert.fail(
			message ??
				`Expected ${Formatter.format(actual)} to have the same members as ${Formatter.format(expected)}`
		)
	}
}

/** Whether `haystack` holds `needle`: a string its substring, a list a member (strict equality). */
const holds = <A>(haystack: string | ReadonlyArray<A>, needle: string | A): boolean =>
	Predicate.isString(haystack)
		? Predicate.isString(needle) && Str.includes(needle)(haystack)
		: Arr.some(haystack, (item) => Object.is(item, needle))

/** The size of a sized collection. */
const sizeOf = (sized: Sized): number => ("length" in sized ? sized.length : sized.size)

/** Fails with `message`, or a description of what was expected of `actual`. */
const refuse = (message: string | undefined, actual: unknown, expected: string): never =>
	nodeAssert.fail(message ?? `Expected ${Formatter.format(actual)} ${expected}`)

/**
 * The part of Vitest's chai `assert` the repositories use, each method under its chai name and with its argument
 * order, judged by node:assert/strict: `equal` and `deepEqual` are strict, so a loose equality chai allowed fails
 * here, closed.
 */
export interface Assert {
	readonly deepStrictEqual: <A>(actual: A, expected: A, message?: string) => void
	readonly strictEqual: <A>(actual: A, expected: A, message?: string) => void
	readonly equal: <A>(actual: A, expected: A, message?: string) => void
	readonly deepEqual: <A>(actual: A, expected: A, message?: string) => void
	readonly notDeepEqual: <A>(actual: A, expected: A, message?: string) => void
	readonly notStrictEqual: <A>(actual: A, expected: A, message?: string) => void
	readonly notEqual: <A>(actual: A, expected: A, message?: string) => void
	readonly ok: (value: unknown, message?: string) => asserts value
	readonly fail: (message?: string) => never
	readonly isTrue: (value: unknown, message?: string) => asserts value is true
	readonly isFalse: (value: unknown, message?: string) => asserts value is false
	readonly isDefined: <A>(value: A, message?: string) => asserts value is Exclude<A, undefined>
	readonly isUndefined: (value: unknown, message?: string) => asserts value is undefined
	readonly isNotNull: <A>(value: A, message?: string) => asserts value is Exclude<A, null>
	readonly isString: (value: unknown, message?: string) => asserts value is string
	readonly isFunction: (value: unknown, message?: string) => void
	readonly isArray: (value: unknown, message?: string) => asserts value is ReadonlyArray<unknown>
	readonly isNotEmpty: (value: Sized | string, message?: string) => void
	readonly isAbove: (value: number, above: number, message?: string) => void
	readonly isBelow: (value: number, below: number, message?: string) => void
	readonly isAtLeast: (value: number, least: number, message?: string) => void
	readonly isAtMost: (value: number, most: number, message?: string) => void
	readonly include: <A>(
		haystack: string | ReadonlyArray<A>,
		needle: string | A,
		message?: string
	) => void
	readonly notInclude: <A>(
		haystack: string | ReadonlyArray<A>,
		needle: string | A,
		message?: string
	) => void
	readonly deepInclude: <A>(haystack: ReadonlyArray<A>, needle: A, message?: string) => void
	readonly match: (value: string, pattern: RegExp, message?: string) => void
	readonly notMatch: (value: string, pattern: RegExp, message?: string) => void
	readonly lengthOf: (value: Sized | string, length: number, message?: string) => void
	readonly instanceOf: <C extends Constructor>(
		value: unknown,
		constructor: C,
		message?: string
	) => asserts value is InstanceOf<C>
	readonly notInstanceOf: (value: unknown, constructor: Constructor, message?: string) => void
	readonly sameMembers: <A>(
		actual: ReadonlyArray<A>,
		expected: ReadonlyArray<A>,
		message?: string
	) => void
	readonly sameDeepMembers: <A>(
		actual: ReadonlyArray<A>,
		expected: ReadonlyArray<A>,
		message?: string
	) => void
	readonly sameOrderedMembers: <A>(
		actual: ReadonlyArray<A>,
		expected: ReadonlyArray<A>,
		message?: string
	) => void
	readonly includeMembers: <A>(
		superset: ReadonlyArray<A>,
		subset: ReadonlyArray<A>,
		message?: string
	) => void
	readonly property: (value: object, name: string, message?: string) => void
	readonly notProperty: (value: object, name: string, message?: string) => void
	readonly propertyVal: (value: object, name: string, expected: unknown, message?: string) => void
	readonly throws: (thunk: () => void, message?: string) => void
}

/** Vitest's chai `assert`, as much of it as the repositories use, on node:assert/strict. */
export const assert: Assert = {
	deepStrictEqual: (actual, expected, message) =>
		judge(
			message,
			() => nodeAssert.deepStrictEqual(actual, expected),
			(said) => nodeAssert.deepStrictEqual(actual, expected, said)
		),
	strictEqual: (actual, expected, message) =>
		judge(
			message,
			() => nodeAssert.strictEqual(actual, expected),
			(said) => nodeAssert.strictEqual(actual, expected, said)
		),
	equal: (actual, expected, message) =>
		judge(
			message,
			() => nodeAssert.strictEqual(actual, expected),
			(said) => nodeAssert.strictEqual(actual, expected, said)
		),
	deepEqual: (actual, expected, message) =>
		judge(
			message,
			() => nodeAssert.deepStrictEqual(actual, expected),
			(said) => nodeAssert.deepStrictEqual(actual, expected, said)
		),
	notDeepEqual: (actual, expected, message) =>
		judge(
			message,
			() => nodeAssert.notDeepStrictEqual(actual, expected),
			(said) => nodeAssert.notDeepStrictEqual(actual, expected, said)
		),
	notStrictEqual: (actual, expected, message) =>
		judge(
			message,
			() => nodeAssert.notStrictEqual(actual, expected),
			(said) => nodeAssert.notStrictEqual(actual, expected, said)
		),
	notEqual: (actual, expected, message) =>
		judge(
			message,
			() => nodeAssert.notStrictEqual(actual, expected),
			(said) => nodeAssert.notStrictEqual(actual, expected, said)
		),
	ok: (value, message) =>
		judge(
			message,
			() => nodeAssert.ok(value),
			(said) => nodeAssert.ok(value, said)
		),
	fail: (message) => nodeAssert.fail(message ?? "assert.fail()"),
	isTrue: (value, message) =>
		judge(
			message,
			() => nodeAssert.strictEqual(value, true),
			(said) => nodeAssert.strictEqual(value, true, said)
		),
	isFalse: (value, message) =>
		judge(
			message,
			() => nodeAssert.strictEqual(value, false),
			(said) => nodeAssert.strictEqual(value, false, said)
		),
	isDefined: (value, message) => {
		if (value === undefined) {
			refuse(message, value, "to be defined")
		}
	},
	isUndefined: (value, message) =>
		judge(
			message,
			() => nodeAssert.strictEqual(value, undefined),
			(said) => nodeAssert.strictEqual(value, undefined, said)
		),
	isNotNull: (value, message) => {
		if (value === null) {
			refuse(message, value, "not to be null")
		}
	},
	isString: (value, message) => {
		if (!Predicate.isString(value)) {
			refuse(message, value, "to be a string")
		}
	},
	isFunction: (value, message) => {
		if (!Predicate.isFunction(value)) {
			refuse(message, value, "to be a function")
		}
	},
	isArray: (value, message) => {
		if (!Arr.isArray(value)) {
			refuse(message, value, "to be an array")
		}
	},
	isNotEmpty: (value, message) => {
		if ((Predicate.isString(value) ? value.length : sizeOf(value)) === 0) {
			refuse(message, value, "not to be empty")
		}
	},
	isAbove: (value, above, message) => {
		if (!(value > above)) {
			refuse(message, value, `to be above ${above}`)
		}
	},
	isBelow: (value, below, message) => {
		if (!(value < below)) {
			refuse(message, value, `to be below ${below}`)
		}
	},
	isAtLeast: (value, least, message) => {
		if (!(value >= least)) {
			refuse(message, value, `to be at least ${least}`)
		}
	},
	isAtMost: (value, most, message) => {
		if (!(value <= most)) {
			refuse(message, value, `to be at most ${most}`)
		}
	},
	include: (haystack, needle, message) => {
		if (!holds(haystack, needle)) {
			refuse(message, haystack, `to include ${Formatter.format(needle)}`)
		}
	},
	notInclude: (haystack, needle, message) => {
		if (holds(haystack, needle)) {
			refuse(message, haystack, `not to include ${Formatter.format(needle)}`)
		}
	},
	deepInclude: (haystack, needle, message) => {
		if (!Arr.some(haystack, (item) => isDeepStrictEqual(item, needle))) {
			refuse(message, haystack, `to deeply include ${Formatter.format(needle)}`)
		}
	},
	match: (value, pattern, message) =>
		judge(
			message,
			() => nodeAssert.match(value, pattern),
			(said) => nodeAssert.match(value, pattern, said)
		),
	notMatch: (value, pattern, message) =>
		judge(
			message,
			() => nodeAssert.doesNotMatch(value, pattern),
			(said) => nodeAssert.doesNotMatch(value, pattern, said)
		),
	lengthOf: (value, length, message) =>
		judge(
			message,
			() =>
				nodeAssert.strictEqual(Predicate.isString(value) ? value.length : sizeOf(value), length),
			(said) =>
				nodeAssert.strictEqual(
					Predicate.isString(value) ? value.length : sizeOf(value),
					length,
					said
				)
		),
	instanceOf: (value, constructor, message) => {
		if (!(value instanceof constructor)) {
			refuse(message, value, `to be an instance of ${constructor.name}`)
		}
	},
	notInstanceOf: (value, constructor, message) => {
		if (value instanceof constructor) {
			refuse(message, value, `not to be an instance of ${constructor.name}`)
		}
	},
	sameMembers: (actual, expected, message) => {
		if (!sameMembersBy(actual, expected, Object.is)) {
			refuse(message, actual, `to have the same members as ${Formatter.format(expected)}`)
		}
	},
	sameDeepMembers: (actual, expected, message) => {
		if (!sameMembersBy(actual, expected, isDeepStrictEqual)) {
			refuse(message, actual, `to have the same deep members as ${Formatter.format(expected)}`)
		}
	},
	sameOrderedMembers: (actual, expected, message) => {
		if (
			actual.length !== expected.length ||
			!Arr.every(actual, (item, at) => Object.is(item, Arr.getUnsafe(expected, at)))
		) {
			refuse(message, actual, `to have the same ordered members as ${Formatter.format(expected)}`)
		}
	},
	includeMembers: (superset, subset, message) => {
		if (!includesMembersBy(superset, subset, Object.is)) {
			refuse(message, superset, `to include the members ${Formatter.format(subset)}`)
		}
	},
	property: (value, name, message) => {
		if (!(name in value)) {
			refuse(message, value, `to have a property ${name}`)
		}
	},
	notProperty: (value, name, message) => {
		if (name in value) {
			refuse(message, value, `not to have a property ${name}`)
		}
	},
	propertyVal: (value, name, expected, message) => {
		if (!(name in value)) {
			refuse(message, value, `to have a property ${name}`)
		}
		judge(
			message,
			() => nodeAssert.strictEqual(Reflect.get(value, name), expected),
			(said) => nodeAssert.strictEqual(Reflect.get(value, name), expected, said)
		)
	},
	throws: (thunk, message) => {
		if (Result.isSuccess(Result.try(thunk))) {
			refuse(message, thunk, "to throw an error")
		}
	}
}

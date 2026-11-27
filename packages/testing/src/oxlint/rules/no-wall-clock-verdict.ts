import { Array as Arr, Option, String as Str } from "effect"
import type { AnyNode, Context, CreateRule, NodeOf } from "#oxlint/rule.ts"
import { isNamed, keyOf, testPathOf, valueOf } from "#oxlint/syntax.ts"
import { isTestScope, VITEST_CONFIGS } from "#scope.ts"

/** The reads of the current time. */
export const CLOCK_READS: ReadonlyArray<string> = [
	"Clock.currentTimeMillis",
	"Clock.currentTimeNanos",
	"Date.now",
	"DateTime.now",
	"DateTime.nowAsDate",
	"DateTime.nowInCurrentZone",
	"DateTime.nowUnsafe",
	"performance.now",
	"process.hrtime"
]

/**
 * The specifiers of the testing library's live clock (live.ts), the one module whose job is the clock: a guard's
 * readings of the work it judges, a declared wait's span, a stopwatch's start, the watchdog's moments. Inside the
 * library it is `#live.ts`; a repository imports it as `@bjornpagen/testing/live`.
 */
export const LIVE_MODULES: ReadonlyArray<string> = ["#live.ts", "@bjornpagen/testing/live"]

/**
 * The live clock's readers, each a read of the current time wherever it is imported: its time in milliseconds and in
 * nanoseconds, as an effect and where no effect runs, a sleep until a moment of it, and the watchdog's next wake
 * moment. live.ts exports none but the last, so no module outside it holds a reading of the clock; an import of one
 * is a read, so a reader exported again is refused where it is used (explore.ts's case guard raced a case against
 * liveSleepUntil(began + caseHang), a read of the clock the rule saw nowhere, and judged the machine: QP-GATE,
 * 2026-11-25).
 */
export const LIVE_READS: ReadonlyArray<string> = [
	"liveMillis",
	"liveMillisNow",
	"liveNanos",
	"liveSleepUntil",
	"watchdogWakes"
]

/**
 * The live clock's timers, each a verdict's time wherever a test or a fixture imports it: a sleep of a while of it, and
 * a stopwatch on it. A test that races its subject against a live sleep, or reads how long it took, judges the machine:
 * resources.test.ts raced its guard's verdict against a sleep of 20 and 60 deadlines for "never judged", and
 * monitor.test.ts an ask against one of 30 s, where the runner's own hang guard ends a case that never ends and states
 * why. A planted case's own wait, the subject a live guard under test judges, is its fixture's, which its configuration
 * names with its reason (oxlint.config.ts).
 */
export const LIVE_TIMERS: ReadonlyArray<string> = ["liveSleep", "stopwatch"]

/** The constructor whose call with no argument, or call as a function, reads the current time. */
export const DATE_READS: ReadonlyArray<string> = ["Date"]

/** The Vitest options whose finite value fails a test or a hook when the wall clock passes it. */
export const VITEST_TIMEOUTS: ReadonlyArray<string> = ["testTimeout", "hookTimeout"]

/** The name a named import imports, whatever local name it binds. */
const importedOf = (specifier: NodeOf<"ImportSpecifier">): string =>
	specifier.imported.type === "Literal" ? specifier.imported.value : specifier.imported.name

/** Whether a timeout is none, as Vitest reads one: `0`, `Infinity` or `Number.POSITIVE_INFINITY`. */
const isUnbounded = (value: AnyNode): boolean =>
	isLiteralZero(value) ||
	(value.type === "Identifier" && value.name === "Infinity") ||
	(value.type === "MemberExpression" &&
		!value.computed &&
		value.object.type === "Identifier" &&
		value.object.name === "Number" &&
		value.property.type === "Identifier" &&
		value.property.name === "POSITIVE_INFINITY")

/** Whether a value is the literal `0`, written where it stands, never a name bound to it. */
const isLiteralZero = (value: AnyNode): boolean => value.type === "Literal" && value.value === 0

/**
 * Whether `name` matches `glob`'s pieces, the text between its `*`s, in order: the first at its start, the last at its
 * end, each `*` any run of characters between them.
 */
const piecesMatch = (name: string, pieces: Arr.NonEmptyReadonlyArray<string>): boolean => {
	const [first, ...rest] = pieces
	if (!Str.startsWith(first)(name)) {
		return false
	}
	const last = Arr.last(rest)
	if (Option.isNone(last)) {
		return name === first
	}
	let at = first.length
	for (const middle of Arr.dropRight(rest, 1)) {
		const found = Str.indexOf(middle)(Str.slice(at)(name))
		if (Option.isNone(found)) {
			return false
		}
		at += found.value + middle.length
	}
	return name.length - last.value.length >= at && Str.endsWith(last.value)(name)
}

/**
 * Whether a file is one of Vitest's configuration files (VITEST_CONFIGS, each a name under any directory, a `*` in the
 * name any run of characters), by its name.
 */
const isVitestConfig = (file: string): boolean => {
	const name = Arr.lastNonEmpty(Str.split("/")(file))
	return Arr.some(VITEST_CONFIGS, (glob) =>
		piecesMatch(name, Str.split("*")(Str.replace("**/", "")(glob)))
	)
}

/** The hooks whose second argument is their timeout: `beforeAll(fn, ms)`. */
const HOOKS: ReadonlyArray<string> = ["beforeAll", "beforeEach", "afterAll", "afterEach"]

/**
 * The test APIs beside a suite, a test and a hook that take a timer as an options object's `timeout`: Effect's Vitest
 * `layer` (`layer(Live, { timeout })`), and the waits that fail when theirs runs out.
 */
const TIMED_OPTIONS: ReadonlyArray<string> = [
	"layer",
	"it.layer",
	"vi.waitFor",
	"vi.waitUntil",
	"expect.poll"
]

const FUNCTIONS: ReadonlyArray<AnyNode["type"]> = ["ArrowFunctionExpression", "FunctionExpression"]

/** Whether a call is a suite's or a test's, a table's included: `it(...)`, `it.effect(...)`, `it.each(rows)(...)`. */
const isTestCall = (context: Context, call: NodeOf<"CallExpression">): boolean =>
	Option.isSome(testPathOf(context, call.callee)) ||
	(call.callee.type === "CallExpression" && Option.isSome(testPathOf(context, call.callee.callee)))

/** An argument at a timeout's place that is no options object and no function: the timeout itself. */
const isBareTimer = (context: Context, node: AnyNode): boolean => {
	const value = valueOf(context, node)
	return (
		node.type !== "SpreadElement" &&
		value.type !== "ObjectExpression" &&
		!Arr.contains(FUNCTIONS, value.type)
	)
}

/** A change to a file's text: the range it replaces and what it writes there. */
type Edit = Readonly<{ range: readonly [number, number]; text: string }>

/** What a rule's fix is handed to make its edits with. */
type Fixer = Parameters<NonNullable<Parameters<Context["report"]>[0]["fix"]>>[0]

/**
 * The edit that deletes element `at` of a list, arguments or properties, with the separator that joins it to its
 * neighbour: the one before it where there is one, else the one after it.
 */
const deletion = (elements: ReadonlyArray<AnyNode>, at: number): Edit => {
	const element = Arr.getUnsafe(elements, at)
	return Option.match(Arr.get(elements, at - 1), {
		onSome: (before) => ({ range: [before.range[1], element.range[1]], text: "" }),
		onNone: () =>
			Option.match(Arr.get(elements, at + 1), {
				onSome: (after) => ({ range: [element.range[0], after.range[0]], text: "" }),
				onNone: () => ({ range: element.range, text: "" })
			})
	})
}

/** The edit that deletes property `at` of an object: the property, or, where it is the object's only one, the
 * object's contents, so `{ timeout: 60_000 }` is `{}`. */
const propertyDeletion = (object: NodeOf<"ObjectExpression">, at: number): Edit =>
	object.properties.length === 1
		? { range: object.range, text: "{}" }
		: deletion(object.properties, at)

/** The fix that makes `edit`. */
const fixOf = (edit: Edit) => (fixer: Fixer) =>
	fixer.replaceTextRange([edit.range[0], edit.range[1]], edit.text)

/** A timer a test API is given: its value, and the edit that deletes it. */
type Timer = Readonly<{ value: AnyNode; edit: Edit }>

/**
 * The `timeout` an options object among a call's arguments states, written there or in a `const` it names: each with
 * the edit that deletes it, the whole argument where it is the options object's only property and the object is
 * written in the call, the property alone otherwise.
 */
const optionTimers = (context: Context, call: NodeOf<"CallExpression">): ReadonlyArray<Timer> =>
	Arr.flatMap(call.arguments, (argument, at) => {
		const options = valueOf(context, argument)
		return options.type === "ObjectExpression"
			? Arr.flatMap(options.properties, (property, index): ReadonlyArray<Timer> =>
					property.type === "Property" && Option.exists(keyOf(property), (key) => key === "timeout")
						? [
								{
									value: property.value,
									edit:
										options === argument && options.properties.length === 1
											? deletion(call.arguments, at)
											: propertyDeletion(options, index)
								}
							]
						: []
				)
			: []
	})

/** The argument of a call at `at` where it is a bare timer, with the edit that deletes it. */
const argumentTimer = (
	context: Context,
	call: NodeOf<"CallExpression">,
	at: number
): ReadonlyArray<Timer> =>
	Arr.map(
		Arr.filter(Option.toArray(Arr.get(call.arguments, at)), (argument) =>
			isBareTimer(context, argument)
		),
		(argument) => ({ value: argument, edit: deletion(call.arguments, at) })
	)

/**
 * The timers a test API's call is given: an options object's `timeout` on a suite, a test, a hook, a layer or a wait;
 * a suite's or a test's third argument, `it(name, fn, ms)`, its options object or its function aside; and a hook's
 * second, `beforeAll(fn, ms)`.
 */
const timersOf = (context: Context, call: NodeOf<"CallExpression">): ReadonlyArray<Timer> => {
	const options = optionTimers(context, call)
	if (isTestCall(context, call)) {
		return [...options, ...argumentTimer(context, call, 2)]
	}
	if (isNamed(context, call.callee, HOOKS)) {
		return [...options, ...argumentTimer(context, call, 1)]
	}
	return isNamed(context, call.callee, TIMED_OPTIONS) ? options : []
}

const WALL_CLOCK =
	"No timer decides a verdict: this makes one rest on the wall clock, so it depends on the machine and the moment, a read of the clock, or a finite timeout (a Vitest testTimeout or hookTimeout, a test's, suite's, hook's or layer's timeout, a wait's), which fails a test when the clock passes it, so a slower machine fails what a faster one passes. Control time with TestClock under it.effect, or assert the fact itself. A Vitest config states testTimeout and hookTimeout in its test block, each as the literal 0, written where it stands: one left out is Vitest's default, 5 s a test and 10 s a hook, a wall-clock verdict, and a name bound to 0 hides that it is none. Leave every other timeout unset or 0, none: a search ends by its case count under each case's hang guard, and a hang is the gate's progress watch to stop."

/**
 * No timer decides a verdict. A read of the current time in a test: `Date.now()`, `new Date()`, `performance.now()`,
 * Effect's `Clock` and `DateTime` reads, and a named import of one of the live clock's readers or timers (LIVE_READS,
 * LIVE_TIMERS from LIVE_MODULES), so a verdict depends on how long something took or when it ran. And every
 * finite timeout a test API is given, which fails a test the moment the wall clock passes it: a `testTimeout` or
 * `hookTimeout` in a Vitest configuration (the preset holds every Vite and Vitest config file to this rule,
 * @bjornpagen/testing/scope VITEST_CONFIGS) or `vi.setConfig`, each of which is the literal `0` and nothing else, and
 * a Vitest config's `test` block that states either not at all, since Vitest then fails a test at 5 s and a hook at
 * 10 s; a test's or a suite's (`it(name, fn, ms)`,
 * `{ timeout }` on it, test or describe, a table's included); a hook's (`beforeAll(fn, ms)`); a layer's (`layer(Live,
 * { timeout })`); and a wait's (`vi.waitFor`, `vi.waitUntil`, `expect.poll`). A timeout is none only as `0`, `Infinity`
 * or `Number.POSITIVE_INFINITY`; any other, a value computed at load among them, is refused, since a slower machine
 * changes neither the cases a search runs nor what they find, and a timer would. `oxlint --fix` deletes each such
 * timer a test API is given: a timer is never load-bearing, since a search has no deadline and the gate owns hangs. It
 * deletes a timeout argument with its separator, a `timeout` property with its separator, and an options object the
 * deletion leaves empty, as an argument a call is given, or `{}` where a `const` holds it. A configuration's
 * testTimeout or hookTimeout it writes as the literal `0`, and one a config's `test` block leaves out it adds as `0`,
 * never deleting it, which would bring Vitest's default back (edullm's HANGFREE, 2026-11-26: the fix deleted
 * qti-pie's testTimeout, and its 5 s default failed crust). A read of the clock it leaves to its author.
 */
export const noWallClockVerdict: CreateRule = {
	meta: { type: "problem", fixable: "code", messages: { wallClock: WALL_CLOCK } },
	create: (context) => {
		const timersRefused = isTestScope(
			Str.startsWith(`${context.cwd}/`)(context.filename)
				? Str.slice(context.cwd.length + 1)(context.filename)
				: context.filename
		)
		return {
			ImportDeclaration: (node) => {
				if (Arr.contains(LIVE_MODULES, node.source.value)) {
					for (const specifier of node.specifiers) {
						if (
							specifier.type === "ImportSpecifier" &&
							(Arr.contains(LIVE_READS, importedOf(specifier)) ||
								(timersRefused && Arr.contains(LIVE_TIMERS, importedOf(specifier))))
						) {
							context.report({ node: specifier, messageId: "wallClock" })
						}
					}
				}
			},
			MemberExpression: (node) => {
				if (isNamed(context, node, CLOCK_READS)) {
					context.report({ node, messageId: "wallClock" })
				}
			},
			NewExpression: (node) => {
				if (isNamed(context, node.callee, DATE_READS) && Arr.isReadonlyArrayEmpty(node.arguments)) {
					context.report({ node, messageId: "wallClock" })
				}
			},
			CallExpression: (node) => {
				if (isNamed(context, node.callee, DATE_READS)) {
					context.report({ node, messageId: "wallClock" })
				}
				for (const { value, edit } of timersOf(context, node)) {
					if (!isUnbounded(value)) {
						context.report({
							node: value,
							messageId: "wallClock",
							fix: fixOf(edit)
						})
					}
				}
			},
			Property: (node) => {
				if (
					node.computed ||
					!Option.exists(keyOf(node), (key) => Arr.contains(VITEST_TIMEOUTS, key)) ||
					isLiteralZero(node.value)
				) {
					return
				}
				context.report({
					node,
					messageId: "wallClock",
					fix: fixOf({ range: node.value.range, text: "0" })
				})
			},
			ObjectExpression: (node) => {
				const parent = node.parent
				if (
					!isVitestConfig(context.physicalFilename) ||
					parent.type !== "Property" ||
					parent.computed ||
					parent.value !== node ||
					!Option.exists(keyOf(parent), (key) => key === "test")
				) {
					return
				}
				const stated = Arr.flatMap(node.properties, (property) =>
					property.type === "Property" && !property.computed ? Option.toArray(keyOf(property)) : []
				)
				const missing = Arr.filter(VITEST_TIMEOUTS, (key) => !Arr.contains(stated, key))
				if (Arr.isReadonlyArrayEmpty(missing)) {
					return
				}
				const written = Arr.join(
					Arr.map(missing, (key) => `${key}: 0`),
					", "
				)
				context.report({
					node,
					messageId: "wallClock",
					fix: fixOf(
						Option.match(Arr.head(node.properties), {
							onNone: () => ({ range: node.range, text: `{ ${written} }` }),
							onSome: (first) => ({ range: [first.range[0], first.range[0]], text: `${written}, ` })
						})
					)
				})
			}
		}
	}
}

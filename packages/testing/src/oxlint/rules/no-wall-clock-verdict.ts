import { Array as Arr, Option } from "effect"
import type { AnyNode, CreateRule } from "#oxlint/rule.ts"
import { isNamed, keyOf } from "#oxlint/syntax.ts"

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

/** The constructor whose call with no argument, or call as a function, reads the current time. */
export const DATE_READS: ReadonlyArray<string> = ["Date"]

/** The Vitest options whose finite value fails a test or a hook when the wall clock passes it. */
export const VITEST_TIMEOUTS: ReadonlyArray<string> = ["testTimeout", "hookTimeout"]

/** Whether a timeout is none, as Vitest reads one: `0`, `Infinity` or `Number.POSITIVE_INFINITY`. */
const isUnbounded = (value: AnyNode): boolean =>
	(value.type === "Literal" && value.value === 0) ||
	(value.type === "Identifier" && value.name === "Infinity") ||
	(value.type === "MemberExpression" &&
		!value.computed &&
		value.object.type === "Identifier" &&
		value.object.name === "Number" &&
		value.property.type === "Identifier" &&
		value.property.name === "POSITIVE_INFINITY")

const WALL_CLOCK =
	"This makes a verdict rest on the wall clock, so it depends on the machine and the moment: a read of the clock, or a finite Vitest testTimeout or hookTimeout, which fails a test when the clock passes it, so a slower machine fails what a faster one passes. Control time with TestClock under it.effect, or assert the fact itself; leave a timeout unset or 0, none: a search ends by its case count under each case's hang guard, and a hang is the gate's progress watch to stop."

/**
 * A verdict that rests on the wall clock. A read of the current time in a test: `Date.now()`, `new Date()`,
 * `performance.now()`, Effect's `Clock` and `DateTime` reads, so a verdict depends on how long something took or when
 * it ran. And a finite `testTimeout` or `hookTimeout` in a Vitest configuration (the preset holds every vitest config
 * file to this rule, @bjornpagen/testing/scope VITEST_CONFIGS), which fails a test the moment the wall clock passes
 * it: anything but `0`, `Infinity` or `Number.POSITIVE_INFINITY`, which Vitest reads as none, a value computed at
 * load among them, since a slower machine changes neither the cases a search runs nor what they find, and a timer
 * would.
 */
export const noWallClockVerdict: CreateRule = {
	meta: { type: "problem", messages: { wallClock: WALL_CLOCK } },
	create: (context) => ({
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
		},
		Property: (node) => {
			if (
				!node.computed &&
				Option.exists(keyOf(node), (key) => Arr.contains(VITEST_TIMEOUTS, key)) &&
				!isUnbounded(node.value)
			) {
				context.report({ node, messageId: "wallClock" })
			}
		}
	})
}

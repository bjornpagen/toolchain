import { Effect } from "effect"
import * as testing from "#fixture/testing.ts"
import {
	constant,
	drawn,
	element,
	exhaust,
	explore,
	map,
	oneOf,
	sketched,
	span,
	weighted
} from "#fixture/testing.ts"

const rows = [
	{ input: 1, expected: 2 },
	{ input: 2, expected: 3 }
] as const

function nonEmpty<A>(items: ReadonlyArray<A>, why: string): ReadonlyArray<A> {
	return why === "" ? [] : items
}

export const inline = exhaust(
	{
		suite: "inline",
		generator: element(["an owner copy", "a predecessor copy", "a last copy"]) // violation
	},
	() => Effect.void
)

export const held = exhaust(
	{
		suite: "held",
		generator: element(rows) // violation
	},
	() => Effect.void
)

export const computed = exhaust(
	{
		suite: "computed",
		generator: element(nonEmpty(rows, "the rows")) // violation
	},
	() => Effect.void
)

export const extended = exhaust(
	{
		suite: "extended",
		generator: element([...rows, { input: 3, expected: 4 }]) // violation
	},
	() => Effect.void
)

export const single = exhaust(
	{
		suite: "single",
		generator: constant({ input: 1, expected: 2 }) // violation
	},
	() => Effect.void
)

export const mapped = exhaust(
	{
		suite: "mapped",
		generator: map(span("rows", element(rows)), (row) => row.input) // violation
	},
	() => Effect.void
)

export const chosen = exhaust(
	{
		suite: "chosen",
		generator: oneOf([element(rows), constant(rows[0])]) // violation
	},
	() => Effect.void
)

export const weighed = exhaust(
	{
		suite: "weighed",
		generator: weighted([ // violation
			[1, element(["a"])],
			[2, constant("b")]
		])
	},
	() => Effect.void
)

export const explored = explore(
	{
		suite: "explored",
		draw: drawn(element(rows)), // violation
		kept: []
	},
	() => Effect.void
)

export const sketch = explore(
	{
		suite: "sketch",
		draw: sketched(element(["a", "b"]), (name) => name.length), // violation
		kept: []
	},
	() => Effect.void
)

const spec = {
	suite: "spec",
	generator: element(rows) // violation
}

export const fromSpec = exhaust(spec, () => Effect.void)

const generator = element(rows)

export const shorthand = exhaust({ suite: "shorthand", generator }, () => Effect.void) // violation

export const namespaced = testing.exhaust(
	{ suite: "namespaced", generator: testing.element(rows) }, // violation
	() => Effect.void
)

const SPACES = { names: ["a", "b"] } as const

export const property = exhaust(
	{ suite: "property", generator: element(SPACES.names) }, // violation
	() => Effect.void
)

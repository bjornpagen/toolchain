import { Effect, Layer, Schema } from "effect"
import type { Settings } from "#fixture/settings.ts"

const LIMITS: ReadonlyMap<string, number> = new Map([["max", 10]])

const NAMES: ReadonlyArray<string> = ["a", "b"]

const WRITTEN: readonly string[] = ["a"]

const PAIR = [0, 0] as const

const TOTALS: Readonly<Record<string, number>> = {}

const BOX = { value: 0 } as const

const SHAPE: Readonly<{ value: number }> = { value: 0 }

const FROZEN = Object.freeze({ value: 0 })

const CHECKED = { value: 0 } as const satisfies Readonly<{ value: number }>

const PATTERN = /^x+$/i

const Name = Schema.String.pipe(Schema.brand("Name"))

const program = Effect.succeed(1)

const live = Layer.empty

const double = (value: number): number => value * 2

const handlers = {
	twice(value: number): number {
		return value * 2
	},
	get zero(): number {
		return 0
	}
}

const EMPTY = {}

type Point = Readonly<{ x: number; y: number }>

const ORIGIN: Point = { x: 0, y: 0 }

interface Bounds {
	readonly min: number
	readonly max: number
}

const BOUNDS: Bounds = { min: 0, max: 1 }

const SETTINGS: Settings = { verbose: false }

declare const ambient: Array<string>

declare global {
	var fixtureAnchor: number | undefined
}

export const anchor = (): number => {
	globalThis.fixtureAnchor = 1
	return (LIMITS.get("max") === undefined ? 0 : 1) + NAMES.length + PAIR[0] + BOX.value + SHAPE.value
}

export const local = (): number => {
	const scratch = new Map<string, number>()
	scratch.set("a", 1)
	let total = 0
	total += scratch.size
	return total
}

export const shadowed = (globalThis: { slot: number }): void => {
	globalThis.slot = 1
}

export const exposed = [
	WRITTEN,
	TOTALS,
	FROZEN,
	CHECKED,
	PATTERN,
	Name,
	program,
	live,
	double,
	handlers,
	EMPTY,
	ORIGIN,
	BOUNDS,
	SETTINGS,
	ambient
] as const

export const registry = new WeakMap<object, string>()
export const encoder = new TextEncoder()
export const decoder = new TextDecoder("utf-8")

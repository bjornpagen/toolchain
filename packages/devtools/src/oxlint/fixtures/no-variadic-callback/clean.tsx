import { Array as Arr, Option, pipe } from "effect"

declare const costs: ReadonlyArray<number>
declare const texts: ReadonlyArray<string>
declare const fold: (f: (a: number, b: number) => number) => number

export const least = Arr.reduce(costs, Number.POSITIVE_INFINITY, (low, cost) => Math.min(low, cost))
export const most = costs.reduce((high, cost) => Math.max(high, cost), 0)
export const piped = pipe(
	costs,
	Arr.reduce(0, (high, cost) => Math.max(high, cost))
)
export const parsed = texts.map((text) => Number.parseInt(text, 10))
export const rounded = costs.map(Math.round)
export const absolute = Arr.map(costs, Math.abs)
export const floats = texts.map(Number.parseFloat)
export const optional = Option.map(Option.some("7"), (text) => Number.parseInt(text, 10))
export const folded = fold(Math.max)
export const called = Math.max(...[1, 2])
export const direct = Math.min(1, 2)

const shadow = (Math: { readonly max: (a: number) => number }) => costs.map(Math.max)

export const shadowed = shadow({ max: (a) => a })

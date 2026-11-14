import * as lists from "#fixture/list.ts"
import { argumentsOf } from "#fixture/list.ts"

declare const pair: readonly [string, string]
declare const either: readonly [number] | readonly [number, number]
declare const optional: readonly [string, number?]
declare const lines: ReadonlyArray<string>
declare const join: (this: unknown, ...parts: Array<string>) => string
declare const area: (width: number, height?: number) => number
declare const label: (name: string, count?: number) => string
declare const builder: Readonly<{ apply: (name: string, left: number, right: number) => number }>

type Size = readonly [width: number, height: number]

declare const size: Size

const LETTERS = ["a", "b"] as const

type Arguments<A> = readonly [] | readonly [A] | readonly [A, A]

const dimensions = (): readonly [number, number] => [1, 2]

function firstTwo<A>(items: ReadonlyArray<A>): Arguments<A> {
	return items.length === 0 ? [] : [items[0] as A]
}

const out: Array<string> = []

out.push(...pair)

export const sized = area(...either)

export const labeled = label(...optional)

export const shaped = area(...[optional[1] ?? 0])

export const measured = area(...size)

export const forward = (...args: Parameters<typeof area>): number => area(...args)

export const relay = (...values: ReadonlyArray<string>): number => out.push(...values)

export const tupled = (dimensions: readonly [number, number]): number => area(...dimensions)

export const copied: ReadonlyArray<string> = [...lines, ...pair]

export const applied = join.apply(undefined, ["a", "b"])

export const reflected = Reflect.apply(join, undefined, ["a", "b"])

out.push(...["a", "b"])

out.push(...LETTERS)

out.push(...(["c", "d"] as const))

for (const line of lines) {
	out.push(line)
}

export const superstarter = { apply: (...parts: ReadonlyArray<string>) => parts.length }

export const own = superstarter.apply(...pair)

export const sum = builder.apply("add", 1, 2)

export const fromLocal = area(...dimensions())

out.push(...firstTwo(lines))

out.push(...argumentsOf(lines))

out.push(...lists.argumentsOf(lines))

const held = argumentsOf(lines)

out.push(...held)

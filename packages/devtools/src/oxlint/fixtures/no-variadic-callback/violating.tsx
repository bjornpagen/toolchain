import { Array as Arr, pipe } from "effect"
import * as A from "effect/Array"
import { reduce } from "effect/Array"

declare const costs: ReadonlyArray<number>
declare const texts: ReadonlyArray<string>
declare const codes: ReadonlyArray<number>
declare const seen: ReadonlySet<number>

export const least = Arr.reduce(costs, Number.POSITIVE_INFINITY, Math.min) // violation
export const most = costs.reduce(Math.max, 0) // violation
export const piped = pipe(costs, Arr.reduce(0, Math.max)) // violation
export const named = reduce(costs, 0, Math.hypot) // violation
export const spaced = A.map(costs, Math.pow) // violation
export const parsed = texts.map(Number.parseInt) // violation
export const radixed = texts.map(parseInt) // violation
export const letters = codes.map(String.fromCharCode) // violation
export const points = codes.flatMap(String.fromCodePoint) // violation
export const wrapped = costs.map(Array.of) // violation
export const listed = Array.from(texts, Array.from) // violation
export const kept = costs.filter(Math.atan2) // violation
export const sorted = costs.toSorted(Math.imul) // violation
export const dated = costs.map(Date.UTC) // violation
export const merged = texts.map(Object.assign) // violation
export const raw = texts.forEach(String.raw) // violation
export const each = seen.forEach(Math.max) // violation

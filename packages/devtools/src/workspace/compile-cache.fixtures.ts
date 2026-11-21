import { boolean, finite, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { COMPILE_CACHE, PASS_THROUGH } from "#workspace/compile-cache.ts"

/**
 * What the turbo-compile-cache property (compile-cache.test.ts) draws: a repository's turbo.json, or none; whether it
 * has a globalPassThroughEnv; and which of the variables a toolchain repository passes through it names, from the roster
 * of the toolchain's own turbo.json (TMPDIR, NODE_OPTIONS and NODE_COMPILE_CACHE), in that order. And the findings the
 * rule's contract gives one.
 */

/** The variables the toolchain's own turbo.json passes through, in its order. */
const ROSTER = ["TMPDIR", "NODE_OPTIONS", COMPILE_CACHE] as const

/** A repository's turbo.json as the rule reads it: none, or one with or without a globalPassThroughEnv of names. */
export type Turbo = Option.Option<Readonly<{ passThrough: Option.Option<ReadonlyArray<string>> }>>

/** Every turbo.json shape: none, no pass-through, and a pass-through of every subset of the roster. */
export const turbos = finite((source): Turbo =>
	source.draw(boolean)
		? Option.some({
				passThrough: source.draw(boolean)
					? Option.some(source.draw(subset(ROSTER, { min: 0, max: ROSTER.length })))
					: Option.none()
			})
		: Option.none()
) satisfies Gen<Turbo>

/** The text of a turbo.json, its pass-through key on its third line where it has one. */
export const textOf = (turbo: Turbo): Option.Option<string> =>
	Option.map(turbo, ({ passThrough }) =>
		Arr.join(
			[
				"{",
				'\t"$schema": "https://turbo.build/schema.json",',
				...Option.match(passThrough, {
					onNone: () => [],
					onSome: (names) => [
						`\t"${PASS_THROUGH}": [${Arr.join(
							Arr.map(names, (name) => `"${name}"`),
							", "
						)}],`
					]
				}),
				'\t"tasks": {}',
				"}",
				""
			],
			"\n"
		)
	)

/**
 * The findings the contract gives `turbo` under `/repo`, as file, line and rule: one at its pass-through key, or its
 * first line where it has none, when it passes no NODE_COMPILE_CACHE; none for a repository with no turbo.json.
 */
export const expectedOf = (
	turbo: Turbo
): ReadonlyArray<Readonly<{ file: string; line: number; rule: string }>> =>
	Option.match(turbo, {
		onNone: () => [],
		onSome: ({ passThrough }) =>
			Option.exists(passThrough, Arr.contains<string>(COMPILE_CACHE))
				? []
				: [
						{
							file: "/repo/turbo.json",
							line: Option.isSome(passThrough) ? 3 : 1,
							rule: "turbo-compile-cache"
						}
					]
	})

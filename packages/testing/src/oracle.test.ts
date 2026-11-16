/**
 * The library's oracles (oracle.ts): a set comparison agrees exactly when both sides hold the same items once each, and
 * finds every repeat, drop and addition, over every pair of permutations of up to 3 of 4 items (an exhaustion against
 * the definition); and it costs no more than grouping by key, its comparisons and key computations growing no faster
 * than linearly in its answers' size (over sizes 2h, 4h and 6h, the second step costs no more than the first).
 */
import { Array as Arr, Effect, Option, Order } from "effect"
import { assertTrue } from "#assert.ts"
import { element, finite, int, shuffled } from "#gen.ts"
import { answersOf, CHANGES, distinct, ITEMS, sameItems, spentAt } from "#oracle.fixtures.ts"
import { exact, set, structuralHash } from "#oracle.ts"
import { property } from "#property.ts"

export const setComparison = property.exhaust(
	finite((source) => {
		const left = source.draw(shuffled(ITEMS, { min: 0, max: 3 }))
		return {
			left,
			right: source.draw(shuffled(left, { min: left.length, max: left.length })),
			change: source.draw(element(CHANGES)),
			at: source.draw(int(0, Math.max(0, left.length - 1)))
		}
	}),
	{
		box: "every list of up to 3 distinct items of 4, against each of its permutations, under no change and under each single repeat, drop and addition",
		needs: {},
		situations: CHANGES,
		check:
			(_resources, c) =>
			({ left, right, change, at }) =>
				Effect.sync(() => {
					c.note(change)
					const [first, second] = answersOf(left, right, change, at)
					const agreed = Option.isNone(set(structuralHash, exact)(first, second))
					const same =
						distinct(first) &&
						distinct(second) &&
						sameItems(Arr.sort(first, Order.String), Arr.sort(second, Order.String))
					assertTrue(
						agreed === same,
						`the comparison ${agreed ? "agreed" : "disagreed"}, and the sides ${same ? "hold" : "do not hold"} the same items once each`
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "both sides sorted and compared, and each side's items counted as a Set"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/oracle.ts",
				original: "([, values, groups]) => Option.isSome(repeatOf(item, values, groups, key))",
				replacement: "() => false",
				why: "A set comparison never looks for a repeat, so an answer that repeats an item agrees with one that holds it once."
			}
		]
	}
)

export const setComparisonCost = property.explore(
	(source) => {
		const half = source.draw(int(1, 600))
		return {
			half,
			change: source.draw(element(CHANGES)),
			at: source.draw(int(0, 2 * half - 1)),
			rotate: source.draw(int(0, 2 * half - 1))
		}
	},
	{
		needs: {},
		situations: CHANGES,
		check:
			(_resources, c) =>
			({ half, change, at, rotate }) =>
				Effect.sync(() => {
					c.note(change)
					const [first, second, third] = Arr.map([1, 2, 3], (k) =>
						spentAt(2 * k * half, change, k * at, k * rotate)
					)
					assertTrue(
						(third ?? 0) - (second ?? 0) <= (second ?? 0) - (first ?? 0),
						`${first}, ${second} and ${third} comparisons and keys at ${2 * half}, ${4 * half} and ${6 * half} items`
					)
				}),
		oracle: {
			kind: "specification",
			name: "items compared only within their key's group: over sizes 2h, 4h and 6h, every place and turn scaled with the size, the second step costs no more than the first"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/oracle.ts",
				original:
					"): boolean => Arr.some(groups.get(key(value)) ?? [], (other) => Option.isNone(item(value, other)))",
				replacement:
					"): boolean => Arr.some(Arr.flatten(Array.from(groups.values())), (other) => Option.isNone(item(value, other)))",
				why: "Every item is compared with every item of the other side, not only with those of its key's group."
			}
		]
	}
)

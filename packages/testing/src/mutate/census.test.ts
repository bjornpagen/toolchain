/**
 * The census (mutate/census.ts) end to end on real worker images: each check of a checkout is a property, and the census
 * says whether it caught a bug. A kill of product source the check goes red under shows it, and else an operator mutant
 * of the product at a place the check ran; a kill of test scope (the harness), a kill that edits nothing and a kept case
 * show nothing, so a check that runs the product without asserting it never caught a bug, whatever its other kills and
 * kept cases; a check red with no mutant, or one that runs the product where its mutants never reach (a child process
 * of a worker that loads the code in process, whose probe survives it), cannot be judged. The checks start processes
 * that load the hook (hook.ts), so the property needs Checkout.dir.
 */
import { Array as Arr, Effect } from "effect"
import { Digest } from "effect/crypto"
import { assert } from "#assert.ts"
import { array, element } from "#gen.ts"
import { noFamilies } from "#mutants.ts"
import {
	type Census,
	checkGen,
	checkoutOf,
	expectedOf,
	KILLS,
	reportOf,
	SOURCES,
	TRACKED
} from "#mutate/census.fixtures.ts"
import { censusOf, productOf } from "#mutate/census.ts"
import { Checkout } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { checkProperty, processPool } from "#mutate/processes.fixtures.ts"
import type { Subject } from "#mutate/schedule.ts"
import { treesOf } from "#mutate/tree.ts"
import { property, PropertyId, ReplayToken } from "#property.ts"
import { noVerdicts } from "#runner/affected.ts"
import { digests } from "#runner/cache.fixtures.ts"
import { runnerLimits } from "#runner/limits.ts"

export const censusOfChecks = property.explore(
	(source): Census => ({
		checks: Arr.prepend(source.draw(array(checkGen, { min: 0, max: 1 })), source.draw(checkGen)),
		loading: source.draw(element(["in-process", "tree"] as const))
	}),
	{
		needs: { checkout: Checkout.dir, digest: digests },
		situations: [
			"catches by kill",
			"catches by mutant",
			"never-caught",
			"unjudged",
			"a harness kill that caught nothing",
			"a kept case that caught nothing"
		],
		check:
			({ digest }, c) =>
			(census) =>
				Effect.gen(function* () {
					const sha = yield* digest
					const checkout = yield* checkoutOf(census)
					const pool = yield* processPool
					const trees = yield* treesOf(checkout)
					const images = yield* imagesOf(checkout, trees)
					const subjects = Arr.map(census.checks, (check, index): Subject => ({
						id: PropertyId(`check${String(index)}`),
						property: checkProperty(
							Arr.map(check.kills, (name) => KILLS[name]),
							Array.from({ length: check.kept }, () => ({
								token: ReplayToken(`check${String(index)}:kept`),
								reason: "a kept case of the check",
								since: "2026-11-19"
							}))
						),
						loading: census.loading
					}))
					const counted = yield* censusOf(pool, images, {
						witnesses: { seed: 1, limits: runnerLimits },
						checkout,
						pkg: checkout,
						subjects,
						product: productOf(TRACKED),
						sources: SOURCES,
						families: noFamilies,
						equivalent: [],
						kills: noVerdicts.kills,
						edits: noVerdicts.edits,
						settled: () => Effect.void
					}).pipe(Effect.provideService(Digest.Digest, sha))
					const reported = Arr.map(counted, reportOf)
					c.noteAll(reported)
					for (const [check, report] of Arr.zip(census.checks, reported)) {
						if (
							report === "never-caught" &&
							Arr.contains(check.kills, "a harness bug") &&
							check.harness
						) {
							c.note("a harness kill that caught nothing")
						}
						if (report === "never-caught" && check.kept > 0) {
							c.note("a kept case that caught nothing")
						}
					}
					assert.deepEqual(
						reported,
						Arr.map(census.checks, (check) => expectedOf(census, check))
					)
				}),
		oracle: {
			kind: "specification",
			name: "unjudged when red with no mutant or run where no mutant reaches; caught by its kill when a product kill turns it red; else by a mutant when it pins the product; else never-caught, whatever its harness kills and kept cases"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/mutate/census.ts",
				original: "tracked.has(file) && !isTestScope(file)",
				replacement: "tracked.has(file)",
				why: "A kill of the harness counts as a catch, so a check that pins only its own support code, and runs the product without asserting it, is kept as one that caught a bug."
			},
			{
				file: "packages/testing/src/mutate/census.ts",
				original: 'one.property === id && one.verdict.kind === "killed" ? [one.kill] : []',
				replacement: "one.property === id ? [one.kill] : []",
				why: "A kill counts whatever its verdict, so a check whose one kill of the product survives it, and which catches nothing else, is counted as catching."
			},
			{
				file: "packages/testing/src/mutate/census.ts",
				original:
					"(pursuit) => Option.isNone(pursuit.found) && pursuit.next < pursuit.queue.length",
				replacement: "(pursuit) => false",
				why: "No operator mutant is ever tried, so a check that pins the product with no kill of its own is counted as never having caught a bug."
			},
			{
				file: "packages/testing/src/mutate/census.ts",
				original: 'verdict.kind === "green" ? [probe] : []',
				replacement: "[]",
				why: "The probes are not read, so a check that runs the product in a child process its mutants never reach is counted as never having caught a bug rather than unjudged."
			},
			{
				file: "packages/testing/src/mutate/operators.ts",
				original: '\t\t\t\tif (verdict.kind === "red") {',
				replacement: "\t\t\t\tif (false) {",
				why: "A check red with no mutant passes its coverage pass and is pursued with mutants, each of whose trials it fails for reasons of its own, so it is counted as catching."
			}
		]
	}
)

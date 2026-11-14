/**
 * The reporter's check of examples (vitest/reporter.ts): a finished test case fails the run exactly when it passed,
 * ran no search, and its package bans examples in its file, where an exemption names a file outright or a directory
 * above it by a path that ends in "/". Oracle: stated in the search.
 */
import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Duration, Effect, Formatter } from "effect"
import { exhaust } from "#explore.ts"
import { requiredInSpace } from "#features.ts"
import { element, int } from "#gen.ts"
import { type Examples, type Finished, isBannedExample } from "#vitest/reporter.ts"
import { searched } from "#vitest/searched.ts"

/** The Vitest root a case's files sit under. */
const ROOT = "/repository/package"

/** A package's stance: examples allowed, or banned with no exemption, one of a directory, or one of a file. */
const STANCES = ["allowed", "banned", "directory exempt", "file exempt"] as const

type Stance = (typeof STANCES)[number]

/** Where a test case's file sits: the file the file exemption names, its sibling in the exempt directory, a file whose
 * name begins with the directory's name, or a file elsewhere. */
const PLACES = ["named", "beside", "prefixed", "elsewhere"] as const

type Place = (typeof PLACES)[number]

const STATES = ["passed", "failed", "skipped", "pending"] as const

const examplesOf = (stance: Stance): Examples => {
	switch (stance) {
		case "allowed":
			return { kind: "allowed" }
		case "banned":
			return { kind: "banned", exempt: [] }
		case "directory exempt":
			return {
				kind: "banned",
				exempt: [{ files: ["src/exempt/"], reason: "a directory's exemption" }]
			}
		case "file exempt":
			return {
				kind: "banned",
				exempt: [{ files: ["src/exempt/named.test.ts"], reason: "a file's exemption" }]
			}
	}
}

const fileOf = (place: Place): string => {
	switch (place) {
		case "named":
			return `${ROOT}/src/exempt/named.test.ts`
		case "beside":
			return `${ROOT}/src/exempt/beside.test.ts`
		case "prefixed":
			return `${ROOT}/src/exemption.test.ts`
		case "elsewhere":
			return `${ROOT}/src/elsewhere.test.ts`
	}
}

/** Whether the stance admits an example at the place, from the exemptions' contract: allowed admits every one, the
 * directory's exemption the two files under it, and the file's exemption the file it names. */
const admits = (stance: Stance, place: Place): boolean =>
	stance === "allowed" ||
	(stance === "directory exempt" && (place === "named" || place === "beside")) ||
	(stance === "file exempt" && place === "named")

type Feature = "a banned example" | "an exempt example" | "a search" | "a case that did not pass"

describe("the reporter's check of examples", () => {
	it.effect(
		"fails a case exactly when it passed having run no search, and its package bans examples in its file",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "examples",
						oracle: {
							kind: "specification",
							name: "the check's contract: passed, no search, banned, and no exemption naming the file or a directory above it"
						},
						box: "every stance, of four places, four states and up to two searches",
						generator: (source) => ({
							stance: source.draw(element(STANCES)),
							place: source.draw(element(PLACES)),
							state: source.draw(element(STATES)),
							searches: source.draw(int(0, 2))
						}),
						literal: Formatter.format,
						coverage: requiredInSpace<Feature>([
							"a banned example",
							"an exempt example",
							"a search",
							"a case that did not pass"
						]),
						caseHang: Duration.minutes(1),
						concurrency: 1
					},
					({ stance, place, state, searches }, c) =>
						Effect.sync(() => {
							const finished: Finished = { state, file: fileOf(place), searches }
							const example = state === "passed" && searches === 0
							const expected = example && !admits(stance, place)
							if (expected) {
								c.note("a banned example")
							}
							if (example && admits(stance, place)) {
								c.note("an exempt example")
							}
							if (searches > 0) {
								c.note("a search")
							}
							if (state !== "passed") {
								c.note("a case that did not pass")
							}
							strictEqual(isBannedExample(examplesOf(stance), ROOT, finished), expected)
						})
				)
			)
	)
})

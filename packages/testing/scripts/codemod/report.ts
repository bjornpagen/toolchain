import { Array as Arr, Order, String as Str } from "effect"

/**
 * Why the codemod leaves a test module to a person: a closed roster, each with the sentence the report prints. A module
 * is converted whole or not at all, so one reason anywhere in it leaves it untouched, and the report lists every reason
 * it met.
 */
const REASONS = {
	"module-statement":
		"a top-level statement that is neither an import, a declaration nor a registration",
	"registration-statement":
		"a statement in a describe or layer block that is neither a declaration nor a test",
	"registration-shape":
		"a describe, layer or it of a shape the codemod does not read (skip, only, each, a computed name, extra options)",
	"test-shape": "an it.effect whose callback is not (ctx) => expression",
	"not-searched": "a test whose body is not searched(ctx, ...): an example or a fact",
	"search-helper":
		"a search run through a helper (a harness): its property is the harness's to build",
	"setup-shape":
		"setup whose last statement is not `return yield* explore|exhaust(...)`, or that returns early",
	"after-search":
		"statements after the search that read its cases together: a check across cases no property states",
	"spec-shape": "a spec that is not an object literal of the search's known fields",
	"draw-shape": "a draw that is not drawn(g), aimed(g, aims) or sketched(g, resolve)",
	"coverage-shape": "a coverage that is not required, requiredInSpace or none (rating included)",
	"property-shape": "a property that is not a function of (value, case)",
	"kept-by-value": "kept cases by value: a kept case becomes a replay token only by running it",
	"box-unstated": "an exhaustion whose box is unstated",
	"space-case-list":
		"space is a case list: element over a literal list, which no property's space may be",
	"space-from-setup": "a space, situations, oracle or box that reads what the setup built",
	"setup-shadowed": "a setup binding the property's parameters or the check's resources shadow",
	"test-context": "a test that reads Vitest's test context beyond searched",
	"test-clock": "a test that drives TestClock",
	layer: "a layer the repository's plugin does not map",
	"hoist-collision": "a describe-local declaration whose name another module-scope name takes",
	"exported-helper":
		"a declaration the test module exports, which another module imports: moving it to the fixtures moves that import",
	"vitest-api":
		"a name read from Vitest that the assert door does not export (expect, vi, TestContext)",
	"fixtures-place":
		"the module's fixtures have no place: a module is already there, or no import map names it",
	"shared-name":
		"a declaration under the name of an import (a type imported, a value declared): one name, two modules",
	"nested-search":
		"a search, draw, coverage or searched run inside a property or a helper: a nested search only a person converts",
	"lazy-effect-export":
		"a helper of no parameters returning an Effect, which exported is a lazy Effect: its callers change with it",
	"codemod-output":
		"the converted module did not parse: a codemod defect, so the module is left as it was"
} as const

export type Reason = keyof typeof REASONS

/** What the report tells a conversion lane about a module the codemod did convert. */
const NOTES = {
	"setup-per-case":
		"effectful setup runs per case now, on the case's own resources: a Template candidate",
	"plant-citations": "plant citations removed from the header: its kills come from them",
	"test-services":
		"ran under it.effect's TestClock and TestConsole, now under the runner's services",
	"dead-declarations": "module declarations only the dropped fields read are removed"
} as const

export type Note = keyof typeof NOTES

/** One line of a module's report: why it was left (a reason) or what its conversion changed (a note), and where. */
export type Finding = Readonly<{ code: Reason | Note; line: number; detail: string }>

/** A module's outcome: converted, left to a person with its reasons, or not a search module at all. */
export type Status = "converted" | "hand" | "not-a-search"

/** A module's report: its outcome and its findings. */
export type Reported = Readonly<{ file: string; status: Status; findings: ReadonlyArray<Finding> }>

const cell = (text: string): string => Str.replaceAll("\t", " ")(Str.replaceAll("\n", " ")(text))

/**
 * The report as TSV: one row per finding (a module with none, one row of its own), then a summary row per status and
 * per code, each `#`-prefixed with its count.
 */
export const tsvOf = (reports: ReadonlyArray<Reported>): string => {
	const rows = Arr.flatMap(reports, (r) =>
		Arr.isReadonlyArrayNonEmpty(r.findings)
			? Arr.map(r.findings, (f) =>
					Arr.join([r.file, r.status, f.code, String(f.line), cell(f.detail)], "\t")
				)
			: [Arr.join([r.file, r.status, "", "", ""], "\t")]
	)
	const counted = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
		Arr.map(
			Arr.sort(Arr.dedupe(keys), Order.String),
			(key) => `#\t${key}\t${Arr.filter(keys, (k) => k === key).length}`
		)
	const byStatus = counted(Arr.map(reports, (r) => r.status))
	const byCode = counted(
		Arr.flatMap(reports, (r) =>
			Arr.map(Arr.dedupe(Arr.map(r.findings, (f) => f.code)), (code) => `${r.status}:${code}`)
		)
	)
	return `${Arr.join(["file\tstatus\tcode\tline\tdetail", ...rows, ...byStatus, ...byCode], "\n")}\n`
}

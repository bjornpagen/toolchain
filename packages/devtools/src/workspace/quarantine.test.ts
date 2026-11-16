import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The quarantine (src/workspace/quarantine.ts), searched over a package's history of one commit and its parent, drawn
 * from a grammar of its contract: the legacy test modules the parent held, the quarantine the parent kept or none (or
 * no parent commit), and a quarantine whose entries are each a legacy module the parent allowed, a module added since
 * (the list grew), a name no tracked file holds, or a glob, written in a list of string literals, with a line comment
 * among them or not; beside a quarantine at no package's root, a list that cannot be read, and exemptions from a test
 * module's shape that name a quarantined module or another. Every part carries the findings the contract gives it, and
 * the quarantine's findings over the commit must be exactly that many.
 *
 * Oracle: the specification, the quarantine's JSDoc: a package's legacy test modules wait in one list at its root that
 * names each outright and only falls. Features: an entry allowed, an entry that grew, an untracked entry, a glob entry,
 * a quarantine at no package's root, an unreadable list, an exemption of a quarantined module, an exemption of another,
 * a root commit.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Result } from "effect"
import { includedOf, QUARANTINE, quarantineFindings, type Snapshot } from "#workspace/quarantine.ts"

type Feature =
	| "an entry allowed"
	| "an entry that grew"
	| "an untracked entry"
	| "a glob entry"
	| "a quarantine at no package's root"
	| "an unreadable list"
	| "an exemption of a quarantined module"
	| "an exemption of another"
	| "a root commit"

/** The package the quarantine keeps, and its legacy test modules in the parent commit. */
const PACKAGE = "packages/plate"
const LEGACY = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts"] as const

/** An entry of the list: its text, whether the current commit tracks the file it names, its findings, what it is. */
type Entry = Readonly<{ text: string; tracked: boolean; findings: number; kind: Feature }>

/** How the parent commit stands: none (a root commit), no quarantine (every legacy module allowed), or a list. */
type Parent =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "unlisted" }>
	| Readonly<{ kind: "listed"; listed: ReadonlyArray<string> }>

const parents: Gen<Parent> = weighted([
	[1, (): Parent => ({ kind: "none" })],
	[1, (): Parent => ({ kind: "unlisted" })],
	[
		2,
		(source): Parent => ({
			kind: "listed",
			listed: Arr.filter(LEGACY, () => source.draw(boolean))
		})
	]
])

/** Whether the parent allows a legacy module: every one where it kept no list or there is none, else its list's. */
const allows = (parent: Parent, entry: string): boolean =>
	parent.kind === "listed" ? Arr.contains(parent.listed, entry) : true

const entryOf =
	(parent: Parent): Gen<Entry> =>
	(source) => {
		const legacy = source.draw(element(LEGACY))
		const grew = parent.kind !== "none"
		return source.draw(
			element([
				allows(parent, legacy)
					? { text: legacy, tracked: true, findings: 0, kind: "an entry allowed" as const }
					: { text: legacy, tracked: true, findings: 1, kind: "an entry that grew" as const },
				grew
					? {
							text: "src/new.test.ts",
							tracked: true,
							findings: 1,
							kind: "an entry that grew" as const
						}
					: { text: "src/new.test.ts", tracked: true, findings: 0, kind: "a root commit" as const },
				{
					text: "src/gone.test.ts",
					tracked: false,
					findings: 1,
					kind: "an untracked entry" as const
				},
				{ text: "src/*.test.ts", tracked: false, findings: 1, kind: "a glob entry" as const },
				{ text: "src/{a,b}.test.ts", tracked: false, findings: 1, kind: "a glob entry" as const },
				{ text: "src/[ab].test.ts", tracked: false, findings: 1, kind: "a glob entry" as const }
			])
		)
	}

/** A quarantine's text: its entries quoted in an `include` list, with a line comment among them or not. */
const textOf = (entries: ReadonlyArray<string>, commented: boolean): string =>
	`import { defineConfig } from "vitest/config"\n\nexport default defineConfig({\n\ttest: {\n\t\tinclude: [\n${Arr.join(
		[
			...(commented ? ["\t\t\t// the legacy modules, falling"] : []),
			...Arr.map(entries, (entry) => `\t\t\t"${entry}"`)
		],
		",\n"
	)}\n\t\t]\n\t}\n})\n`

type Commit = Readonly<{
	parent: Parent
	entries: ReadonlyArray<Entry>
	commented: boolean
	atRoot: boolean
	readable: boolean
	exemptions: ReadonlyArray<Readonly<{ glob: string; findings: number; kind: Feature }>>
}>

const commits: Gen<Commit> = (source) => {
	const parent = source.draw(parents)
	const entries = Arr.dedupeWith(
		source.draw(array(entryOf(parent), { min: 1, max: 4 })),
		(a, b) => a.text === b.text
	)
	const quarantined = Arr.filter(entries, (entry) => entry.kind === "an entry allowed")
	const exemptions = source.draw(
		array(
			(inner) =>
				Arr.isReadonlyArrayNonEmpty(quarantined) && inner.draw(boolean)
					? {
							glob: `${PACKAGE}/${inner.draw(element(quarantined)).text}`,
							findings: 0,
							kind: "an exemption of a quarantined module" as const
						}
					: {
							glob: `${PACKAGE}/src/converted.test.ts`,
							findings: 1,
							kind: "an exemption of another" as const
						},
			{ min: 0, max: 2 }
		)
	)
	return {
		parent,
		entries,
		commented: source.draw(boolean),
		atRoot: source.draw(mostly),
		readable: source.draw(mostly),
		exemptions: Arr.dedupeWith(exemptions, (a, b) => a.glob === b.glob)
	}
}

/** True three times in four: a quarantine at its root with a list that reads is the common commit. */
const mostly: Gen<boolean> = weighted([
	[3, constant(true)],
	[1, constant(false)]
])

const QUARANTINE_PATH = `${PACKAGE}/${QUARANTINE}`

/** The parent commit's files: the package's manifest and its legacy modules. */
const PARENT_FILES: ReadonlyArray<string> = [
	`${PACKAGE}/package.json`,
	...Arr.map(LEGACY, (legacy) => `${PACKAGE}/${legacy}`)
]

/** The parent commit as the quarantine reads it. */
const parentOf = (parent: Parent): Option.Option<Snapshot> => {
	switch (parent.kind) {
		case "none":
			return Option.none()
		case "unlisted":
			return Option.some({ files: PARENT_FILES, textOf: () => Option.none() })
		case "listed": {
			const listed = textOf(parent.listed, false)
			return Option.some({
				files: [QUARANTINE_PATH, ...PARENT_FILES],
				textOf: (path) => (path === QUARANTINE_PATH ? Option.some(listed) : Option.none())
			})
		}
	}
}

/** The findings the contract gives a commit. An unreadable list states one finding for itself and quarantines nothing,
 * so every exemption names a module no quarantine holds. */
const expectedOf = (commit: Commit): number => {
	const root = commit.atRoot ? 0 : 1
	if (!commit.readable) {
		return root + 1 + commit.exemptions.length
	}
	return (
		root +
		Arr.reduce(commit.entries, 0, (sum, entry) => sum + entry.findings) +
		Arr.reduce(commit.exemptions, 0, (sum, exemption) => sum + exemption.findings)
	)
}

/** The quarantine's findings over a commit. */
const findingsOf = (commit: Commit): number => {
	const tracked = [
		QUARANTINE_PATH,
		...(commit.atRoot ? [`${PACKAGE}/package.json`] : []),
		...Arr.map(LEGACY, (legacy) => `${PACKAGE}/${legacy}`),
		`${PACKAGE}/src/new.test.ts`,
		`${PACKAGE}/src/converted.test.ts`
	]
	const text = commit.readable
		? textOf(
				Arr.map(commit.entries, (entry) => entry.text),
				commit.commented
			)
		: 'export default { test: { include: ["src/a.test.ts", legacy] } }'
	return quarantineFindings({
		root: "/repository",
		current: {
			files: tracked,
			textOf: (path) => (path === QUARANTINE_PATH ? Option.some(text) : Option.none())
		},
		parent: parentOf(commit.parent),
		lintConfig: "oxlint.config.ts",
		shapeExemptions: Arr.map(commit.exemptions, (exemption) => exemption.glob)
	}).length
}

describe("the quarantine", () => {
	it.effect("gives each commit exactly the findings its quarantine and exemptions draw", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "workspace/quarantine",
					oracle: {
						kind: "specification",
						name: "the quarantine's stated contract: one list at a package's root, naming each legacy module outright, only falling"
					},
					draw: drawn(commits),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"an entry allowed",
							"an entry that grew",
							"an untracked entry",
							"a glob entry",
							"a quarantine at no package's root",
							"an unreadable list",
							"an exemption of a quarantined module",
							"an exemption of another",
							"a root commit"
						],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(commit, c) =>
					Effect.sync(() => {
						for (const entry of commit.entries) {
							c.note(entry.kind)
						}
						for (const exemption of commit.exemptions) {
							c.note(exemption.kind)
						}
						if (!commit.atRoot) {
							c.note("a quarantine at no package's root")
						}
						if (!commit.readable) {
							c.note("an unreadable list")
						}
						if (commit.parent.kind === "none") {
							c.note("a root commit")
						}
						deepStrictEqual(findingsOf(commit), expectedOf(commit))
					})
			)
		)
	)
	it.effect("reads back every list it is written as", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "workspace/quarantine/list",
					oracle: {
						kind: "specification",
						name: "a quarantine's include list, as written, read back"
					},
					draw: drawn((source) => ({
						entries: source.draw(array(element(LEGACY), { min: 0, max: 4 })),
						commented: source.draw(boolean)
					})),
					literal: Formatter.format,
					coverage: required<"a list read">(["a list read"], { cases: 100, sense: notesOnly }),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				({ entries, commented }, c) =>
					Effect.sync(() => {
						c.note("a list read")
						deepStrictEqual(includedOf(textOf(entries, commented)), Result.succeed(entries))
					})
			)
		)
	)
})

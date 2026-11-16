import {
	array,
	boolean,
	characterOf,
	codePoint,
	constant,
	element,
	type Gen,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { QUARANTINE, quarantineFindings, type Snapshot } from "#workspace/quarantine.ts"

/**
 * The commits and lists the quarantine's properties draw (quarantine.test.ts), from a grammar of its contract: a
 * package's history of one commit and its parent, its quarantine's entries each allowed, grown, untracked or a glob,
 * its exemptions, and the findings the contract gives each part; and lists as written, whose entries are any text of a
 * path's characters and a list's punctuation.
 */

/** What a commit holds, as the commit property names its situations. */
export type Feature =
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
export const textOf = (entries: ReadonlyArray<string>, commented: boolean): string =>
	`import { defineConfig } from "vitest/config"\n\nexport default defineConfig({\n\ttest: {\n\t\tinclude: [\n${Arr.join(
		[
			...(commented ? ["\t\t\t// the legacy modules, falling"] : []),
			...Arr.map(entries, (entry) => `\t\t\t"${entry}"`)
		],
		",\n"
	)}\n\t\t]\n\t}\n})\n`

/** A commit: its parent, its quarantine's entries and how the list is written, and its shape exemptions. */
export type Commit = Readonly<{
	parent: Parent
	entries: ReadonlyArray<Entry>
	commented: boolean
	atRoot: boolean
	readable: boolean
	exemptions: ReadonlyArray<Readonly<{ glob: string; findings: number; kind: Feature }>>
}>

export const commits: Gen<Commit> = (source) => {
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
export const expectedOf = (commit: Commit): number => {
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
export const findingsOf = (commit: Commit): number => {
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

/** The situations a commit reaches: each entry's and exemption's kind, a quarantine at no package's root, an
 * unreadable list, a root commit. */
export const featuresOf = (commit: Commit): ReadonlyArray<Feature> => [
	...Arr.map(commit.entries, (entry) => entry.kind),
	...Arr.map(commit.exemptions, (exemption) => exemption.kind),
	...(commit.atRoot ? [] : (["a quarantine at no package's root"] as const)),
	...(commit.readable ? [] : (["an unreadable list"] as const)),
	...(commit.parent.kind === "none" ? (["a root commit"] as const) : [])
]

/** What a written list is, as the read-back property names its situations. */
export type Written =
	| "an empty list"
	| "a list of several entries"
	| "a commented list"
	| "an entry that holds a list's punctuation"

/** The characters a list parts its items with and closes on, and the other quote, each of which an entry may hold. */
const PUNCTUATION = [" ", ",", "[", "]", "'"] as const

/**
 * A character of an entry: a path's (a letter, a digit, a separator, a dot, a joiner, a glob's marks) or a list's
 * punctuation, which a reader that splits on it rather than reading each literal to its closing quote would misread.
 */
const entryCharacter: Gen<string> = oneOf<string>([
	codePoint(0x61, 0x7a),
	codePoint(0x30, 0x39),
	characterOf(["/", ".", "-", "_", "*", "{", "}"]),
	characterOf(PUNCTUATION)
])

/** A list as written: its entries, any text of entry characters, and whether a line comment opens it. */
export type List = Readonly<{ entries: ReadonlyArray<string>; commented: boolean }>

export const lists: Gen<List> = (source) => ({
	entries: source.draw(array(string(entryCharacter, { min: 0, max: 12 }), { min: 0, max: 4 })),
	commented: source.draw(boolean)
})

/** The situations a written list reaches. */
export const writtenOf = (list: List): ReadonlyArray<Written> => [
	...(Arr.isReadonlyArrayEmpty(list.entries) ? (["an empty list"] as const) : []),
	...(list.entries.length > 1 ? (["a list of several entries"] as const) : []),
	...(list.commented ? (["a commented list"] as const) : []),
	...(Arr.some(list.entries, (entry) => Arr.some(PUNCTUATION, (mark) => Str.includes(mark)(entry)))
		? (["an entry that holds a list's punctuation"] as const)
		: [])
]

import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { array, boolean, element, type Gen, int, shuffled } from "#gen.ts"
import { applied, type Family, type Mutant, type Operator } from "#mutants.ts"

/**
 * The statement shapes the operators are tested against, each with identifiers distinct so no mutant is the statement
 * unchanged.
 */
export const SHAPES = [
	"guard",
	"conjunct",
	"disjunct",
	"negation",
	"boolean",
	"conditional",
	"if-else",
	"switch",
	"call",
	"fallback",
	"difference",
	"quantifier",
	"array",
	"pipe",
	"effect-fn",
	"option-some",
	"loose",
	"negative",
	"markup"
] as const

type Shape = (typeof SHAPES)[number]

/** One statement of a program: its shape, its three identifiers, a bound, a flag, a quantifier and an Effect.fn kind. */
type Statement = Readonly<{
	shape: Shape
	names: ReadonlyArray<string>
	bound: number
	flag: boolean
	quantifier: "some" | "every"
	fn: "fn" | "fnUntraced"
}>

const statementGen: Gen<Statement> = (source) => ({
	shape: source.draw(element(SHAPES)),
	names: source.draw(shuffled(["a", "b", "c"], { min: 3, max: 3 })),
	bound: source.draw(int(0, 9)),
	flag: source.draw(element([true, false])),
	quantifier: source.draw(element(["some", "every"])),
	fn: source.draw(element(["fn", "fnUntraced"]))
})

/** A program of one to six statements. */
export const programGen: Gen<ReadonlyArray<Statement>> = array(statementGen, { min: 1, max: 6 })

/** The statement's text, its value bound to `v<index>` where it has one. */
const textOf = (statement: Statement, index: number): string => {
	const [x = "", y = "", z = ""] = statement.names
	const v = `v${String(index)}`
	const n = String(statement.bound)
	switch (statement.shape) {
		case "guard":
			return `if (${x} < ${n}) { return ${y} }`
		case "conjunct":
			return `const ${v} = ${x} && ${y}`
		case "disjunct":
			return `const ${v} = ${x} || ${y}`
		case "negation":
			return `const ${v} = !${x}`
		case "boolean":
			return `const ${v} = ${String(statement.flag)}`
		case "conditional":
			return `const ${v} = ${x} ? ${y} : ${z}`
		case "if-else":
			return `if (${x}) { ${y}() } else { ${z}() }`
		case "switch":
			return `switch (${x}) { case 0: ${y}(); break; case 1: ${z}(); break }`
		case "call":
			return `${x}()`
		case "fallback":
			return `const ${v} = ${x} ?? ${y}`
		case "difference":
			return `const ${v} = ${x} - ${y}`
		case "quantifier":
			return `const ${v} = ${x}.${statement.quantifier}((e) => e > ${n})`
		case "array":
			return `const ${v} = [${x}, ${y}]`
		case "pipe":
			return `const ${v} = ${x}.pipe(${y}, ${z})`
		case "effect-fn":
			return `const ${v} = Effect.${statement.fn}(function* () {}, ${y}, ${z})`
		case "option-some":
			return `const ${v} = Option.some(${x})`
		case "loose":
			return `const ${v} = ${x} == ${y}`
		case "negative":
			return `if (${x} < -${n}) { return ${y} }`
		case "markup":
			return `const ${v} = <p>{${x} && <b>{${y}}</b>}</p>`
	}
}

/** Operators, each with a count. */
export type Counts = ReadonlyArray<readonly [Operator, number]>

/** The operators a statement must yield, each with its count. */
export const expectedOf = (shape: Shape): Counts => {
	switch (shape) {
		case "guard":
			return [
				["comparison", 1],
				["guard", 1],
				["bound", 2]
			]
		case "conjunct":
			return [["conjunct", 2]]
		case "disjunct":
			return [["disjunct", 2]]
		case "negation":
			return [["negation", 1]]
		case "boolean":
			return [["boolean", 1]]
		case "conditional":
			return [["arm-swap", 1]]
		case "if-else":
			return [
				["arm-swap", 1],
				["statement", 2]
			]
		case "switch":
			return [
				["arm-swap", 1],
				["statement", 4]
			]
		case "call":
			return [["statement", 1]]
		case "fallback":
			return [["fallback", 1]]
		case "difference":
			return [["operand-swap", 1]]
		case "quantifier":
			return [
				["quantifier", 1],
				["comparison", 1],
				["bound", 2],
				["boolean-return", 2]
			]
		case "array":
			return [["element", 2]]
		case "pipe":
			return [["pipe-stage", 2]]
		case "effect-fn":
			return [["pipe-stage", 2]]
		case "option-some":
			return []
		case "loose":
			return [["comparison", 1]]
		case "negative":
			return [
				["comparison", 1],
				["guard", 1],
				["bound", 2]
			]
		case "markup":
			return [["conjunct", 2]]
	}
}

/** Each operator's total over several counts. */
export const counted = (counts: ReadonlyArray<Counts>) =>
	Arr.reduce(Arr.flatten(counts), Rec.empty<string, number>(), (sum, [operator, n]) =>
		Rec.set(sum, operator, (sum[operator] ?? 0) + n)
	)

/** The program's file: a TSX module when a statement holds markup, which only TSX reads, and a TypeScript one otherwise. */
export const programFile = (statements: ReadonlyArray<Statement>): string =>
	Arr.some(statements, (statement) => statement.shape === "markup") ? "program.tsx" : "program.ts"

/** The program's text: its statements, one a line, in the body of a function named `run`. */
export const statementsText = (statements: ReadonlyArray<Statement>) =>
	`const run = () => {\n${Arr.join(
		Arr.map(statements, (statement, index) => `\t${textOf(statement, index)}`),
		"\n"
	)}\n}\n`

/** The line and column, from one, at which `offset` stands in `text`. */
export const placeOf = (text: string, offset: number) => {
	const before = Str.split(Str.slice(0, offset)(text), "\n")
	return {
		line: before.length,
		column: Option.getOrElse(Arr.last(before), () => "").length + 1
	}
}

/** The files a family case lists, some under sql/, which the family applies to, and some elsewhere. */
const FAMILY_FILES = ["sql/print.ts", "sql/plan.ts", "src/other.ts", "lib/text.ts"] as const

/** A family case's file: its name, and the string literals it declares in order. */
type FamilyFile = Readonly<{ name: string; literals: ReadonlyArray<"a" | "c"> }>

/**
 * A family case: files of distinct names, each declaring a few string literals, "a" (a site the family's rule finds) or
 * "c" (none), and how many copies of the one rule the family holds.
 */
type FamilyCase = Readonly<{ files: ReadonlyArray<FamilyFile>; rules: number }>

/** A family case of one to three files and one to three copies of the rule. */
export const familyCase: Gen<FamilyCase> = (source) => ({
	files: Arr.map(source.draw(shuffled(FAMILY_FILES, { min: 1, max: 3 })), (name) => ({
		name,
		literals: source.draw(array(element(["a", "c"] as const), { min: 0, max: 3 }))
	})),
	rules: source.draw(int(1, 3))
})

/** Whether the family applies to a file: those under sql/. */
export const appliesToSql = (file: string): boolean => Str.startsWith("sql/")(file)

/** A file declaring each literal in order, one declaration a line. */
export const literalsText = (literals: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(literals, (literal, at) => `export const name${at} = "${literal}"\n`),
		""
	)

/** A family whose `copies` rules each propose the same edit: every "a" literal becomes "b", in the files `applies` names. */
export const renamingFamily = (
	applies: (file: string) => boolean,
	copies: number
): Family<"rename"> => {
	const rule: Family<"rename">["rules"][number] = (node, site) => {
		if (site.source.kind !== node.kind && site.slice(node) === `"a"`) {
			site.add("rename", site.span(node), `"b"`)
		}
	}
	return {
		operators: ["rename"],
		applies,
		rules: Arr.prepend(
			Array.from({ length: copies - 1 }, () => rule),
			rule
		)
	}
}

/** A renamed file: its name and its text with one site renamed. */
type Renamed = readonly [file: string, text: string]

const byPlace: Order.Order<Renamed> = Order.combine(
	Order.mapInput(Order.String, (entry: Renamed) => entry[0]),
	Order.mapInput(Order.String, (entry: Renamed) => entry[1])
)

/**
 * The family's mutants by a second implementation: each "a" literal of each file the family applies to, replaced by
 * "b" alone, as the file and its text, in order.
 */
export const renamedOf = (files: ReadonlyArray<FamilyFile>): ReadonlyArray<Renamed> =>
	Arr.sort(
		Arr.flatMap(files, (file) =>
			appliesToSql(file.name)
				? Arr.flatMap(file.literals, (literal, at): ReadonlyArray<Renamed> =>
						literal === "a"
							? [
									[
										file.name,
										literalsText(
											Arr.map(file.literals, (other, place) => (place === at ? "b" : other))
										)
									]
								]
							: []
					)
				: []
		),
		byPlace
	)

/** The family's mutants as the mutator made them: each rename's file and the file's text it makes, in order. */
export const renamesOf = <O extends string>(
	mutants: ReadonlyArray<Mutant<O>>
): ReadonlyArray<Renamed> =>
	Arr.sort(
		Arr.map(
			Arr.filter(mutants, (mutant) => mutant.operator === "rename"),
			(mutant): Renamed => [mutant.file, applied(mutant)]
		),
		byPlace
	)

/** A kill case: a text of a few parts and the original a kill names, which may stand in it once, nowhere or more. */
type KillCase = Readonly<{ parts: ReadonlyArray<string>; original: string }>

/** A kill case of up to six parts over an alphabet whose originals overlap. */
export const killCase: Gen<KillCase> = (source) => ({
	parts: source.draw(array(element(["x", "y", "xy", " "]), { min: 0, max: 6 })),
	original: source.draw(element(["x", "xy", "yx"]))
})

/** Every offset at which `original` stands in `text`, by a second implementation: the text split at every offset. */
export const placesIn = (text: string, original: string): ReadonlyArray<number> =>
	Arr.filter(
		Array.from({ length: text.length + 1 }, (_, i) => i),
		(at) => Str.slice(at, at + original.length)(text) === original
	)

/** How an element of an array literal is written: none of them holds a mutant of its own. */
const ITEMS = ["a", "f(a)", "() => a", "{ k: a }", "...a"] as const

/** What joins two elements: a comma and a space, or a comma and a new line. */
const JOINS = [", ", ",\n\t\t"] as const

/**
 * An array literal of two to six elements: each element's text, what joins each to the one before, whether a space
 * follows the bracket, and whether a comma trails the last element.
 */
export type Literal = Readonly<{
	items: ReadonlyArray<string>
	joins: ReadonlyArray<string>
	padded: boolean
	trailing: boolean
}>

export const literalGen: Gen<Literal> = (source) => {
	const items = source.draw(array(element(ITEMS), { min: 2, max: 6 }))
	return {
		items,
		joins: Arr.map(Arr.drop(items, 1), () => source.draw(element(JOINS))),
		padded: source.draw(boolean),
		trailing: source.draw(boolean)
	}
}

/** The literal's text. */
export const literalText = (literal: Literal) =>
	`[${literal.padded ? " " : ""}${Arr.join(
		Arr.map(
			literal.items,
			(item, index) => `${index === 0 ? "" : (literal.joins[index - 1] ?? "")}${item}`
		),
		""
	)}${literal.trailing ? "," : ""}]`

/** Where the literal stands in its program, the binding of `xs` in `run`'s body. */
export const literalProgram = (literal: Literal) => {
	const before = "const run = () => {\n\tconst xs = "
	return { text: `${before}${literalText(literal)}\n}\n`, at: before.length }
}

/** An element mutant as the oracle states it: where it begins, the text it replaces and what it writes there. */
export type ElementEdit = Readonly<{ start: number; original: string; replacement: string }>

/**
 * Each element's mutant, by the rule's contract: the first from the bracket to the next element, the bracket written
 * back; any other from where the element before it ends to its own end, nothing written.
 */
export const elementEditsOf = (literal: Literal, at: number): ReadonlyArray<ElementEdit> => {
	const pad = literal.padded ? " " : ""
	const edits: Array<ElementEdit> = []
	let end = at + 1 + pad.length
	for (const [index, item] of literal.items.entries()) {
		const join = literal.joins[index === 0 ? 0 : index - 1] ?? ""
		edits.push(
			index === 0
				? { start: at, original: `[${pad}${item}${join}`, replacement: "[" }
				: { start: end, original: `${join}${item}`, replacement: "" }
		)
		end += (index === 0 ? 0 : join.length) + item.length
	}
	return edits
}

/** A text with every space, tab and line break taken out. */
export const unspaced = (text: string) =>
	Arr.join(
		Arr.filter(Arr.fromIterable(text), (character) => Str.trim(character) !== ""),
		""
	)

/** The literal with element `index` dropped, as its elements and commas read with every space removed. */
export const droppedShape = (literal: Literal, index: number) =>
	unspaced(`[${Arr.join(Arr.remove(literal.items, index), ",")}${literal.trailing ? "," : ""}]`)

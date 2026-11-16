import { Array as Arr, Option, String as Str } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { testPathOf } from "#oxlint/syntax.ts"

/** The modules of the runner a test module replaces, and every subpath of each: Vitest's and @effect/vitest's. */
export const VITEST_MODULES: ReadonlyArray<string> = ["vitest", "@effect/vitest"]

const isVitestModule = (source: string): boolean =>
	Arr.some(VITEST_MODULES, (module) => source === module || Str.startsWith(`${module}/`)(source))

/** A type declaration: a type alias or an interface, which a test module may hold beside its properties. */
const isTypeDeclaration = (node: AnyNode): boolean =>
	node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration"

/**
 * An exported property: `export const name = <call>`, every declarator a name bound to a call that is no suite or test
 * of Vitest's (`describe`, `it`, `test`).
 */
const isExportedProperty = (context: Context, declaration: AnyNode): boolean =>
	declaration.type === "VariableDeclaration" &&
	declaration.kind === "const" &&
	Arr.every(
		declaration.declarations,
		(declarator) =>
			declarator.id.type === "Identifier" &&
			declarator.init?.type === "CallExpression" &&
			Option.isNone(testPathOf(context, declarator.init.callee))
	)

/** Whether a top-level statement is one a test module may hold. */
const isAdmitted = (context: Context, statement: AnyNode): boolean => {
	if (statement.type === "ImportDeclaration") {
		return !isVitestModule(statement.source.value)
	}
	if (statement.type === "ExportNamedDeclaration") {
		return (
			statement.source === null &&
			statement.declaration !== null &&
			(isTypeDeclaration(statement.declaration) ||
				isExportedProperty(context, statement.declaration))
		)
	}
	return isTypeDeclaration(statement)
}

/**
 * A test module's shape: a test is a value, so a test module is data. Its top level holds imports (none of Vitest's
 * or @effect/vitest's), type declarations, and `export const name = <call>` where the call builds a Property or a
 * Family (`property.explore(...)`, a harness's constructor); every other top-level statement is refused: a suite or a
 * test of Vitest's, a statement, a function, a helper or a generator held by a const of its own, a default export, a
 * re-export. The rule reads one file's syntax; the preset scopes it to test modules.
 */
export const testModuleShape = refusal(
	"testModuleShape",
	"A test module is data: its top level holds imports, type declarations and `export const name = property.explore(...)` (or another call that builds a Property or a Family) only. Move a helper or a generator to a support module; Vitest's suites, tests and imports have no place in a test module.",
	(context, refuse) => ({
		Program: (program) => {
			Arr.forEach(
				Arr.filter(program.body, (statement) => !isAdmitted(context, statement)),
				refuse
			)
		}
	})
)

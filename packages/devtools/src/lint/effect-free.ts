import { Array as Arr, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import { type Finding, findingAt } from "#shared/finding.ts"

/** Effect itself, or a module of a package of its `@effect` scope. */
const isEffectModule = (specifier: string): boolean =>
	specifier === "effect" ||
	Str.startsWith("effect/")(specifier) ||
	Str.startsWith("@effect/")(specifier)

/** The Effect module a top-level import or re-export names, when the declaration loads it at run time: every form
 * but `import type` and `export type`. `import { type T }` loads it, since type stripping leaves `import {}`. */
const loadedEffectModuleOf = (statement: ts.Statement): Result.Result<ts.Node, void> => {
	if (ts.isImportDeclaration(statement)) {
		const typeOnly = statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
		return ts.isStringLiteral(statement.moduleSpecifier) &&
			isEffectModule(statement.moduleSpecifier.text) &&
			!typeOnly
			? Result.succeed(statement)
			: Result.failVoid
	}
	if (ts.isExportDeclaration(statement)) {
		const { moduleSpecifier } = statement
		return moduleSpecifier !== undefined &&
			ts.isStringLiteral(moduleSpecifier) &&
			isEffectModule(moduleSpecifier.text) &&
			!statement.isTypeOnly
			? Result.succeed(statement)
			: Result.failVoid
	}
	return Result.failVoid
}

/**
 * The imports of an Effect-free package's source that load Effect at run time. Such a package names Effect's types
 * with `import type` alone, which leaves nothing at run time, so Effect is the peer its declarations need and never a
 * module its code loads. superlint, run in a package the toolchain's effectFree lists, reports each.
 */
export const effectFreeFindingsOf = (sourceFile: ts.SourceFile): ReadonlyArray<Finding> =>
	Arr.map(Arr.filterMap(sourceFile.statements, loadedEffectModuleOf), (node) =>
		findingAt({
			sourceFile,
			rule: "effect-free-packages",
			report: {
				node,
				message:
					"This package is Effect-free, but this declaration loads Effect at run time: type stripping keeps every import but `import type` and `export type`.",
				suggestion:
					"Import Effect's types with `import type`, or take the package off toolchain.config.ts's effectFree if it uses Effect."
			}
		})
	)

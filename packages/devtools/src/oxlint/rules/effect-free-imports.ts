import { String as Str } from "effect"
import { type AnyNode, problem } from "#oxlint/rule.ts"

/** Effect itself, or a module of a package of its `@effect` scope. */
const isEffectModule = (specifier: string): boolean =>
	specifier === "effect" ||
	Str.startsWith("effect/")(specifier) ||
	Str.startsWith("@effect/")(specifier)

const MESSAGE =
	"This package is Effect-free, but this declaration loads Effect at run time: type stripping keeps every import but `import type` and `export type`. Import Effect's types with `import type`, or take the package off toolchain.config.ts's effectFree if it uses Effect."

/**
 * The imports and re-exports of an Effect-free package's source that load Effect at run time. Such a package names
 * Effect's types with `import type` alone, which leaves nothing at run time, so Effect is the peer its declarations need
 * and never a module its code loads. Every form but `import type`, `export type` and `export type *` loads it:
 * `import { type T }` too, since type stripping leaves `import {}`. The preset runs it on the Effect-free code alone.
 */
export const effectFreeImports = problem((context) => {
	const check = (node: AnyNode, specifier: string, typeOnly: boolean): void => {
		if (isEffectModule(specifier) && !typeOnly) {
			context.report({ node, message: MESSAGE })
		}
	}
	return {
		ImportDeclaration: (node) => {
			check(node, node.source.value, node.importKind === "type")
		},
		ExportNamedDeclaration: (node) => {
			if (node.source !== null) {
				check(node, node.source.value, node.exportKind === "type")
			}
		},
		ExportAllDeclaration: (node) => {
			check(node, node.source.value, node.exportKind === "type")
		}
	}
})

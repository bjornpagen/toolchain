import { Array as Arr } from "effect"
import { isLimitsExempt, LimitsOptions, packagesOf } from "#oxlint/limits.ts"
import { type AnyNode, configured } from "#oxlint/rule.ts"

/** The module of the Limit and its four mints. */
const LIMIT_MODULE = "@bjornpagen/limit"

/** The mints of a Limit, by the names @bjornpagen/limit exports them under. */
const MINTS: ReadonlyArray<string> = ["published", "measured", "derived", "provisional"]

/** The name an import or export specifier spells: an identifier, or a string such as `"published"`. */
const nameOf = (node: AnyNode): string => {
	if (node.type === "Identifier") {
		return node.name
	}
	return node.type === "Literal" && typeof node.value === "string" ? node.value : ""
}

/**
 * A Limit minted outside the repository's limits packages: a call of `published`, `measured`, `derived` or
 * `provisional` imported from @bjornpagen/limit, by name, renamed, or off a namespace import, and a re-export of one,
 * which would open a second door. Every limit of a codebase is minted in its limits package and read by its `.value`
 * everywhere else, so a reader finds every number and its evidence in one place. Test files are exempt: a test may mint
 * a Limit to drive the code it tests.
 */
export const limitsSoleMint = configured(LimitsOptions, (context, options) => {
	if (isLimitsExempt(context, options)) {
		return {}
	}
	const message = `A Limit is minted only in the limits package, ${packagesOf(options)}: mint it there, import it, and read its .value here.`
	const mints = new Set<string>()
	const namespaces = new Set<string>()
	const calls: Array<Extract<AnyNode, { type: "CallExpression" }>> = []
	return {
		ImportDeclaration: (node) => {
			if (node.source.value !== LIMIT_MODULE || node.importKind === "type") {
				return
			}
			for (const specifier of node.specifiers) {
				if (specifier.type === "ImportNamespaceSpecifier") {
					namespaces.add(specifier.local.name)
				} else if (
					specifier.type === "ImportSpecifier" &&
					specifier.importKind !== "type" &&
					Arr.contains(MINTS, nameOf(specifier.imported))
				) {
					mints.add(specifier.local.name)
				}
			}
		},
		ExportNamedDeclaration: (node) => {
			if (
				node.source?.value === LIMIT_MODULE &&
				node.exportKind !== "type" &&
				Arr.some(node.specifiers, (specifier) => Arr.contains(MINTS, nameOf(specifier.local)))
			) {
				context.report({ node, message })
			}
		},
		ExportAllDeclaration: (node) => {
			if (node.source.value === LIMIT_MODULE && node.exportKind !== "type") {
				context.report({ node, message })
			}
		},
		CallExpression: (node) => {
			calls.push(node)
		},
		"Program:exit": () => {
			for (const call of calls) {
				const callee = call.callee
				const minted =
					(callee.type === "Identifier" && mints.has(callee.name)) ||
					(callee.type === "MemberExpression" &&
						!callee.computed &&
						callee.object.type === "Identifier" &&
						namespaces.has(callee.object.name) &&
						callee.property.type === "Identifier" &&
						Arr.contains(MINTS, callee.property.name))
				if (minted) {
					context.report({ node: call, message })
				}
			}
		}
	}
})

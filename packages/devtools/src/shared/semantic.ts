import { Array as Arr, Predicate } from "effect"
import * as ts from "typescript/ast"
import {
	type Checker,
	type Symbol as NativeSymbol,
	type NodeHandle,
	type Signature,
	SymbolFlags,
	type Type
} from "typescript/sync"
import type { RoundTrip } from "#shared/native-api.ts"
import { everyNode, preorder } from "#shared/nodes.ts"

/**
 * One source file's checker lookups. Every checker call is a synchronous IPC round trip, so the lookups the rules make
 * at many nodes are fetched for the whole file at once, each kind on its first use in the file, and answered from
 * memory afterwards: the symbols of its names and callees in one call, the targets of the aliases among those symbols
 * in one round trip, and the signatures its calls and tagged templates resolve to in one more. A file no rule makes a
 * kind of lookup in makes none of its calls. A lookup outside its batch falls back to a single call and is remembered
 * too.
 */
export type Semantics = Readonly<{
	/** The symbol the checker binds at a node, exactly as getSymbolAtLocation returns it (aliases unresolved). */
	symbolAt: (node: ts.Node) => NativeSymbol | undefined
	/** The symbol an import alias finally refers to; a symbol that is no alias is its own target. */
	aliasTarget: (symbol: NativeSymbol) => NativeSymbol
	/** The type the checker gives an expression, or undefined when the native checker has none. */
	typeAt: (node: ts.Node) => Type | undefined
	/** A symbol's declarations as nodes; a handle the compiler cannot resolve is left out. */
	declarationsOf: (symbol: NativeSymbol) => ReadonlyArray<ts.Node>
	/** The declaration of the signature the checker resolves a call, construction or tagged template to, or undefined
	 * when the resolved signature has none (an unresolved call) or its handle does not resolve. */
	signatureDeclarationAt: (node: ts.Node) => ts.Node | undefined
}>

/** The nodes whose symbols the rules read at `node`: identifiers, member names and callees. */
const isNamed = Predicate.or(ts.isIdentifier, ts.isPropertyAccessExpression)

const isInvocation = Predicate.or(ts.isCallExpression, ts.isNewExpression)

const symbolNodesAt = (node: ts.Node): ReadonlyArray<ts.Node> => {
	const named = isNamed(node) ? [node] : []
	const called = isInvocation(node) ? [node.expression] : []
	return [...named, ...called]
}

/** The nodes whose resolved signatures the rules read: calls and tagged templates. */
const isSignatureSite = Predicate.or(ts.isCallExpression, ts.isTaggedTemplateExpression)

const isAlias = (symbol: NativeSymbol | undefined): symbol is NativeSymbol =>
	symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0

/** Every node `select` picks at the nodes of a file, in document order, walked without deepening the call stack. */
const nodesOf = (
	sourceFile: ts.SourceFile,
	select: (node: ts.Node) => ReadonlyArray<ts.Node>
): ReadonlyArray<ts.Node> => {
	const nodes: Array<ts.Node> = []
	for (const node of preorder(sourceFile, everyNode)) {
		for (const at of select(node)) {
			nodes.push(at)
		}
	}
	return nodes
}

export const prepareSemantics = (
	input: Readonly<{ sourceFile: ts.SourceFile; checker: Checker; roundTrip: RoundTrip }>
): Semantics => {
	const { checker, roundTrip } = input
	let fetchedSymbols: Map<ts.Node, NativeSymbol | undefined> | undefined
	const symbolsOfFile = (): Map<ts.Node, NativeSymbol | undefined> => {
		if (fetchedSymbols === undefined) {
			const nodes = nodesOf(input.sourceFile, symbolNodesAt)
			fetchedSymbols = new Map(Arr.zip(nodes, checker.getSymbolAtLocation(nodes)))
		}
		return fetchedSymbols
	}
	let fetchedTargets: Map<number, NativeSymbol> | undefined
	const targetsOfFile = (): Map<number, NativeSymbol> => {
		if (fetchedTargets === undefined) {
			const aliases = Arr.fromIterable(
				new Map(
					Arr.map(Arr.filter(Arr.fromIterable(symbolsOfFile().values()), isAlias), (alias) => [
						alias.id,
						alias
					])
				).values()
			)
			fetchedTargets = new Map(
				Arr.zip(
					Arr.map(aliases, (alias) => alias.id),
					roundTrip(Arr.map(aliases, (alias) => checker.getAliasedSymbol.gen(alias)))
				)
			)
		}
		return fetchedTargets
	}
	let fetchedSignatures: Map<ts.Node, Signature> | undefined
	const signaturesOfFile = (): Map<ts.Node, Signature> => {
		if (fetchedSignatures === undefined) {
			const sites = nodesOf(input.sourceFile, (node) => (isSignatureSite(node) ? [node] : []))
			fetchedSignatures = new Map(
				Arr.zip(sites, roundTrip(Arr.map(sites, (site) => checker.getResolvedSignature.gen(site))))
			)
		}
		return fetchedSignatures
	}
	const types = new Map<ts.Node, Type | undefined>()
	const resolved = new Map<NodeHandle, ts.Node | undefined>()

	const symbolAt = (node: ts.Node): NativeSymbol | undefined => {
		const symbols = symbolsOfFile()
		if (symbols.has(node)) {
			return symbols.get(node)
		}
		const symbol = checker.getSymbolAtLocation(node)
		symbols.set(node, symbol)
		return symbol
	}
	const aliasTarget = (symbol: NativeSymbol): NativeSymbol => {
		if (!isAlias(symbol)) {
			return symbol
		}
		const targets = targetsOfFile()
		const known = targets.get(symbol.id)
		if (known !== undefined) {
			return known
		}
		const target = checker.getAliasedSymbol(symbol)
		targets.set(symbol.id, target)
		return target
	}
	const typeAt = (node: ts.Node): Type | undefined => {
		if (types.has(node)) {
			return types.get(node)
		}
		const type = checker.getTypeAtLocation(node)
		types.set(node, type)
		return type
	}
	const resolve = (handle: NodeHandle): ts.Node | undefined => {
		if (resolved.has(handle)) {
			return resolved.get(handle)
		}
		const node = handle.resolve()
		resolved.set(handle, node)
		return node
	}
	const declarationsOf = (symbol: NativeSymbol): ReadonlyArray<ts.Node> => {
		const nodes: Array<ts.Node> = []
		for (const handle of symbol.declarations) {
			const node = resolve(handle)
			if (node !== undefined) {
				nodes.push(node)
			}
		}
		return nodes
	}
	const signatureDeclarations = new Map<ts.Node, ts.Node | undefined>()
	const signatureDeclarationAt = (node: ts.Node): ts.Node | undefined => {
		if (signatureDeclarations.has(node)) {
			return signatureDeclarations.get(node)
		}
		const signature = signaturesOfFile().get(node) ?? checker.getResolvedSignature(node)
		const handle = signature.declaration
		const declaration = handle === undefined ? undefined : resolve(handle)
		signatureDeclarations.set(node, declaration)
		return declaration
	}
	return { symbolAt, aliasTarget, typeAt, declarationsOf, signatureDeclarationAt }
}

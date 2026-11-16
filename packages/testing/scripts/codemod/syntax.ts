import { Array as Arr, Option, String as Str } from "effect"
import * as ts from "typescript/ast"
import { API } from "typescript/sync"

/** A module the codemod reads: its path from the repository root, its text and its syntax tree. */
export type Parsed = Readonly<{ file: string; text: string; tree: ts.SourceFile }>

/**
 * Parses modules through TypeScript 7's native API, one compiler process for the whole run: `parse` reads a module's
 * text into its tree, and `close` ends the process.
 */
export type Parser = Readonly<{
	parse: (file: string, text: string) => Parsed
	close: () => void
}>

export const openParser = (cwd: string): Parser => {
	const api = new API({ cwd })
	return {
		parse: (file, text) => ({ file, text, tree: api.createSourceFile(file, text).sourceFile }),
		close: () => api.close()
	}
}

/** A node's own text, without the comments and blank lines before it. */
export const textOf = (node: ts.Node): string => {
	const tree = node.getSourceFile()
	return Str.slice(node.getStart(tree), node.end)(tree.text)
}

/** A node's text with the comments that lead it (its JSDoc), from their first character. */
export const withCommentsOf = (parsed: Parsed, node: ts.Node): string =>
	Str.trimStart(Str.slice(node.pos, node.end)(parsed.text))

/** The 1-based line a node's own text starts on. */
export const lineOf = (parsed: Parsed, node: ts.Node): number =>
	Str.split(Str.slice(0, node.getStart(parsed.tree))(parsed.text), "\n").length

/** An expression without the parentheses around it. */
export const unparenthesized = (expression: ts.Expression): ts.Expression =>
	ts.isParenthesizedExpression(expression) ? unparenthesized(expression.expression) : expression

/** What a call calls, as written: `explore`, `it.effect`, `Effect.gen`; a callee of another shape is its kind. */
export const calleeOf = (call: ts.CallExpression): string => {
	const callee = unparenthesized(call.expression)
	return ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)
		? textOf(callee)
		: ts.SyntaxKind[callee.kind]
}

/** A string literal's value, or a template without substitutions'. */
export const stringValueOf = (expression: ts.Expression): Option.Option<string> => {
	const bare = unparenthesized(expression)
	return ts.isStringLiteral(bare) || ts.isNoSubstitutionTemplateLiteral(bare)
		? Option.some(bare.text)
		: Option.none()
}

/**
 * Whether an identifier is a name a scope can bind, read as a reference: not the name of a property read, assigned,
 * declared or imported under another name.
 */
const isReference = (identifier: ts.Identifier): boolean => {
	const parent = identifier.parent
	if (ts.isPropertyAccessExpression(parent)) {
		return parent.expression === identifier
	}
	if (ts.isQualifiedName(parent)) {
		return parent.left === identifier
	}
	if (
		ts.isPropertyAssignment(parent) ||
		ts.isPropertySignatureDeclaration(parent) ||
		ts.isMethodDeclaration(parent) ||
		ts.isMethodSignatureDeclaration(parent) ||
		ts.isPropertyDeclaration(parent) ||
		ts.isGetAccessorDeclaration(parent) ||
		ts.isSetAccessorDeclaration(parent) ||
		ts.isEnumMember(parent)
	) {
		return parent.name !== identifier
	}
	if (ts.isBindingElement(parent)) {
		return parent.propertyName !== identifier
	}
	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
		return parent.propertyName !== identifier
	}
	return !(ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent))
}

/** Whether an identifier is the name a declaration binds: a variable's, a parameter's, a function's or a type's. */
const isDeclared = (identifier: ts.Identifier): boolean => {
	const parent = identifier.parent
	return (
		(ts.isVariableDeclaration(parent) ||
			ts.isParameterDeclaration(parent) ||
			ts.isBindingElement(parent) ||
			ts.isFunctionDeclaration(parent) ||
			ts.isFunctionExpression(parent) ||
			ts.isClassDeclaration(parent) ||
			ts.isClassExpression(parent) ||
			ts.isInterfaceDeclaration(parent) ||
			ts.isTypeAliasDeclaration(parent) ||
			ts.isEnumDeclaration(parent) ||
			ts.isTypeParameterDeclaration(parent) ||
			ts.isImportSpecifier(parent) ||
			ts.isImportClause(parent) ||
			ts.isNamespaceImport(parent)) &&
		parent.name === identifier
	)
}

/** Every identifier under a node, by name, each as often as it is written: what a fresh name must avoid. */
export const namesUnder = (node: ts.Node): ReadonlyArray<string> => {
	const found: Array<string> = []
	const visit = (child: ts.Node): undefined => {
		if (ts.isIdentifier(child)) {
			found.push(child.text)
		}
		child.forEachChild(visit)
		return undefined
	}
	visit(node)
	return found
}

/** The names a block-like list of statements binds for its whole scope: its declarations and its functions'. */
const statementNames = (statements: ReadonlyArray<ts.Statement>): ReadonlyArray<string> =>
	Arr.flatMap(statements, (s) =>
		ts.isVariableStatement(s) ||
		ts.isFunctionDeclaration(s) ||
		ts.isClassDeclaration(s) ||
		ts.isInterfaceDeclaration(s) ||
		ts.isTypeAliasDeclaration(s) ||
		ts.isEnumDeclaration(s)
			? declaredNamesOf(s)
			: []
	)

/** The type parameters a declaration binds. */
const typeParametersOf = (
	parameters: ReadonlyArray<ts.TypeParameterDeclaration> | undefined
): ReadonlyArray<string> => Arr.map(parameters ?? [], (p) => p.name.text)

/**
 * The names a node binds for what is inside it, when it opens a scope: a function its parameters, type parameters, own
 * name and body's declarations; a block its declarations; a loop its head's variables; a catch its variable; a class
 * or a type its type parameters. The module itself opens none, so its own declarations stay reads.
 */
const scopeOf = (node: ts.Node): ReadonlyArray<string> => {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	) {
		const body = node.body
		return [
			...Arr.flatMap(node.parameters, (p) => boundNamesOf(p.name)),
			...typeParametersOf(node.typeParameters),
			...(ts.isFunctionExpression(node) && node.name !== undefined ? [node.name.text] : []),
			...(body !== undefined && ts.isBlock(body) ? statementNames(body.statements) : [])
		]
	}
	if (ts.isBlock(node) || ts.isModuleBlock(node)) {
		return statementNames(node.statements)
	}
	if (ts.isCaseBlock(node)) {
		return Arr.flatMap(node.clauses, (clause) => statementNames(clause.statements))
	}
	if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
		const head = node.initializer
		return head !== undefined && ts.isVariableDeclarationList(head)
			? Arr.flatMap(head.declarations, (d) => boundNamesOf(d.name))
			: []
	}
	if (ts.isCatchClause(node)) {
		return node.variableDeclaration === undefined ? [] : boundNamesOf(node.variableDeclaration.name)
	}
	if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
		return [
			...typeParametersOf(node.typeParameters),
			...(ts.isClassExpression(node) && node.name !== undefined ? [node.name.text] : [])
		]
	}
	if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
		return typeParametersOf(node.typeParameters)
	}
	if (ts.isMappedTypeNode(node)) {
		return [node.typeParameter.name.text]
	}
	return []
}

/**
 * Every name read under a node from outside it, each as often as it is read: an identifier in a reference, not a
 * declared name or a property's, that no scope inside the node binds. A module's own declarations are reads of it.
 */
export const identifiersUnder = (node: ts.Node): ReadonlyArray<string> =>
	Arr.map(referencesUnder(node), (identifier) => identifier.text)

/** The names declared anywhere under a node: its variables', parameters', functions' and types'. */
export const declaredUnder = (node: ts.Node): ReadonlyArray<string> => {
	const found: Array<string> = []
	const visit = (child: ts.Node): undefined => {
		if (ts.isIdentifier(child) && isDeclared(child)) {
			found.push(child.text)
		}
		child.forEachChild(visit)
		return undefined
	}
	visit(node)
	return found
}

/** The identifiers under a node that read a name from outside it, in source order (identifiersUnder's, as nodes). */
export const referencesUnder = (node: ts.Node): ReadonlyArray<ts.Identifier> => {
	const found: Array<ts.Identifier> = []
	const visit =
		(bound: ReadonlySet<string>) =>
		(child: ts.Node): undefined => {
			if (
				ts.isIdentifier(child) &&
				isReference(child) &&
				!isDeclared(child) &&
				!bound.has(child.text)
			) {
				found.push(child)
			}
			const scope = scopeOf(child)
			child.forEachChild(
				Arr.isReadonlyArrayNonEmpty(scope) ? visit(new Set([...bound, ...scope])) : visit(bound)
			)
			return undefined
		}
	visit(new Set())(node)
	return found
}

/** The names a binding pattern or a declaration's name binds. */
export const boundNamesOf = (name: ts.BindingName): ReadonlyArray<string> => {
	if (ts.isIdentifier(name)) {
		return [name.text]
	}
	return Arr.flatMap(name.elements, (element) =>
		ts.isBindingElement(element) && element.name !== undefined ? boundNamesOf(element.name) : []
	)
}

/** The names a statement declares in its scope: a variable statement's, a function's, a class's or a type's. */
export const declaredNamesOf = (statement: ts.Statement): ReadonlyArray<string> => {
	if (ts.isVariableStatement(statement)) {
		return Arr.flatMap(statement.declarationList.declarations, (d) => boundNamesOf(d.name))
	}
	if (
		ts.isFunctionDeclaration(statement) ||
		ts.isClassDeclaration(statement) ||
		ts.isInterfaceDeclaration(statement) ||
		ts.isTypeAliasDeclaration(statement) ||
		ts.isEnumDeclaration(statement)
	) {
		return statement.name === undefined ? [] : [statement.name.text]
	}
	return []
}

/** Whether a statement only declares: a const, a function, a class, an interface, a type or an enum. */
export const isDeclaration = (statement: ts.Statement): boolean =>
	(ts.isVariableStatement(statement) &&
		(statement.declarationList.flags & ts.NodeFlags.Const) !== 0) ||
	ts.isFunctionDeclaration(statement) ||
	ts.isClassDeclaration(statement) ||
	ts.isInterfaceDeclaration(statement) ||
	ts.isTypeAliasDeclaration(statement) ||
	ts.isEnumDeclaration(statement)

/** Whether a node holds an expression of a kind: a yield, an await, a `new`. */
export const holds = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
	const visit = (child: ts.Node): boolean | undefined =>
		child.kind === kind ? true : child.forEachChild(visit)
	return visit(node) === true
}

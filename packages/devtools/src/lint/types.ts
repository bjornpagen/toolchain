import type * as ts from "typescript/ast"
import type { Checker } from "typescript/sync"
import type { Report } from "#shared/finding.ts"
import type { Semantics } from "#shared/semantic.ts"

/** What the engine hands every rule of a file: one owned source file, its program's checker, the file's prepared
 * semantic lookups, and the directory the options' paths are relative to. */
export type FileContext = Readonly<{
	sourceFile: ts.SourceFile
	checker: Checker
	semantics: Semantics
	/** The directory the options' paths are relative to: the repository root, or the fixtures' for a fixture run. */
	root: string
}>

/** What a rule sees: the file, and the options of the pack the rule belongs to. */
export type RuleContext<O> = FileContext & Readonly<{ options: O }>

/** A rule prepares once per file and answers the visitor that the engine's one traversal calls with every node of
 * the file, in document order. It reports nodes; the engine stamps the rule's id. */
export type Visitor<C> = (context: C) => (node: ts.Node) => ReadonlyArray<Report>

/** A rule's visitor over its context. A rule that reads no options takes them as `unknown`, so it runs in any pack. */
export type Visit<O> = Visitor<RuleContext<O>>

/** What a rule sees of the program a run lints, once, before any file: the program's checker. */
export type ProgramContext = Readonly<{ checker: Checker }>

/** What a rule that guards the linted package's public surface sees of the program: its checker, and the source
 * module of every public subpath of the package's `exports` map (lint/surface.ts), empty for a package that exports
 * nothing. The engine reads the surface only for a run that starts such a rule. */
export type SurfaceContext = Readonly<{ checker: Checker; surface: ReadonlyArray<string> }>

/** A rule starts once per program, where it may read the whole program, and answers the Visit each file gets. */
export type Start<O> = (program: ProgramContext) => Visit<O>

/** A rule that starts on the program and its public surface. */
export type SurfaceStart<O> = (program: SurfaceContext) => Visit<O>

/** How a rule starts, over the context its visitor takes: on each file alone, once per program, or once per program
 * with its public surface. */
export type Starting<C> =
	| Readonly<{ reads: "file"; visit: Visitor<C> }>
	| Readonly<{ reads: "program"; start: (program: ProgramContext) => Visitor<C> }>
	| Readonly<{ reads: "surface"; start: (program: SurfaceContext) => Visitor<C> }>

/**
 * Whether the gate runs a rule on the tree. Every rule runs against its fixtures. A pending rule is registered while the
 * tree still holds its violations: the gate leaves it out, `superlint --pending` runs it beside the rest, and it is
 * turned on once its violations are fixed.
 */
export type Gate = "on" | "pending"

/** One superlint rule: the id it reports under (its name in the output and its fixture directory), how it starts, and
 * whether the gate runs it. Every rule visits every owned file, test files included. */
export type Rule<O> = Readonly<{ id: string; starting: Starting<RuleContext<O>>; gate: Gate }>

/** A rule with the options it runs under bound to it: what the engine runs, seeing only the file. */
export type BoundRule = Readonly<{ id: string; starting: Starting<FileContext>; gate: Gate }>

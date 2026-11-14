import type * as ts from "typescript/ast"

/** The file a node of the program belongs to, by the name the compiler gives it: what a repository's own superlint
 * rule reads through `@bjornpagen/devtools/superlint/sql`. The SQL rules that read Drizzle are the oxlint plugin's
 * (src/oxlint/drizzle.ts). */
export const fileOf = (node: ts.Node): string => node.getSourceFile().fileName

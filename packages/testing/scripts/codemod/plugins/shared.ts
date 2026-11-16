import { Array as Arr, Option } from "effect"
import type * as ts from "typescript/ast"
import type { Provision } from "#codemod/plugin.ts"
import type { Parsed } from "#codemod/syntax.ts"

/** The platform's layers, which every check already has (CheckContext's NodeServices): each goes. */
const PLATFORM: ReadonlyArray<string> = [
	"NodeServices.layer",
	"NodeFileSystem.layer",
	"NodePath.layer",
	"NodeChildProcessSpawner.layer"
]

/** A provision table: each layer's text, and what it becomes. */
export const provisionsBy =
	(table: ReadonlyArray<readonly [string, Provision]>) =>
	(text: string): Option.Option<Provision> =>
		Option.map(
			Arr.findFirst(table, ([layer]) => layer === text),
			([, provision]) => provision
		)

/** The platform's layers, ambient. */
export const ambient: ReadonlyArray<readonly [string, Provision]> = Arr.map(
	PLATFORM,
	(layer) => [layer, { kind: "ambient" }] as const
)

/** A plugin that unwraps nothing: its tests' bodies are searched(...) calls themselves. */
export const unwrapsNothing = (
	_parsed: Parsed,
	_body: ts.Expression
): Option.Option<ts.Expression> => Option.none()

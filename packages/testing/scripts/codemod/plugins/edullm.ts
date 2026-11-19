import { Option } from "effect"
import * as ts from "typescript/ast"
import type { Plugin } from "#codemod/plugin.ts"
import { ambient, provisionsBy } from "#codemod/plugins/shared.ts"
import { calleeOf, unparenthesized } from "#codemod/syntax.ts"

/**
 * A test body that checks its exhaustion's count against the space it counted, or taps its count onto the test
 * (`Effect.flatMap(searched(...), (exhausted) => ...)`, `searched(...).pipe(Effect.tap(counted(ctx)))`): the runner
 * counts a FiniteSpace before any case runs and reports every property's line, so the check and the report go and the
 * search is what is left.
 */
const unwrap = (body: ts.Expression): Option.Option<ts.Expression> => {
	const bare = unparenthesized(body)
	if (!ts.isCallExpression(bare)) {
		return Option.none()
	}
	if (calleeOf(bare) === "Effect.flatMap" && bare.arguments.length === 2) {
		return Option.fromNullishOr(bare.arguments[0])
	}
	const callee = unparenthesized(bare.expression)
	const stage = bare.arguments[0]
	return ts.isPropertyAccessExpression(callee) &&
		callee.name.text === "pipe" &&
		bare.arguments.length === 1 &&
		stage !== undefined &&
		ts.isCallExpression(stage) &&
		calleeOf(stage) === "Effect.tap" &&
		stage.arguments[0] !== undefined &&
		ts.isCallExpression(stage.arguments[0]) &&
		calleeOf(stage.arguments[0]) === "counted"
		? Option.some(callee.expression)
		: Option.none()
}

/** edullm (github.com/superbuilders/edullm): its platform, data and qti-pie packages. */
export const edullm: Plugin = {
	include: [
		"packages/platform/**/*.test.ts",
		"packages/data/**/*.test.ts",
		"packages/qti-pie/**/*.test.ts"
	],
	provision: provisionsBy(ambient),
	stages: [],
	builders: [],
	unwrap
}

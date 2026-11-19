/**
 * The side-effect-free rule (src/oxlint/rules/side-effect-free.ts), searched over programs drawn from a grammar of its
 * own contract: functions marked `@__NO_SIDE_EFFECTS__`, and unmarked ones, whose bodies hold sites the contract proves
 * (their own locals read, assigned and called, the language's constants, proven calls, Math's functions and
 * conversions, `toString` on a primitive, a proven constant of the module or a listed one, a marked or listed proven
 * function, what a proven factory returns, a parameter's property called as a callback, a call passing a proven
 * callback) beside sites it refuses (an outer read or write, an unproven constant, a property written, changed or
 * deleted, a parameter or a method of a value called, a global called, Math.random, a value frozen it does not build,
 * a callback no proof covers, the forbidden syntax), marks on no function, and a proof's own module, each claim of the
 * options kept or broken. Every site carries the number of reports the contract gives it inside a marked function, and
 * a call passing a callback the number it gives it anywhere, and oxlint's RuleTester, run in the case, must find
 * exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc read over the lists its module exports (MARKS, BUILTIN_CALLS,
 * MATH_FUNCTIONS, CALLABLE_GLOBALS, PURE_GLOBALS, FORBIDDEN), never a list written again here. Features: a proven
 * site in a marked function, each clause of the contract a site breaks in a marked function (the space is aimed at
 * each, so every refusal the rule makes is among the witnesses), a callback no proof covers outside a marked function,
 * an unmarked function, a misplaced mark, a program of several functions, and a proof's module, each claim kept or
 * broken.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import {
	featuresOf,
	homes,
	judgedHome,
	judgedProgram,
	programs
} from "#oxlint/rules/side-effect-free.fixtures.ts"

/** Reports exactly what its contract refuses in a marked function, and nothing else. */
export const markedFunctionRefusals = property.explore(programs, {
	needs: {},
	situations: [
		"a proven site in a marked function",
		"an outer variable written in a marked function",
		"an outer variable read in a marked function",
		"a property written in a marked function",
		"a property changed in a marked function",
		"a property deleted in a marked function",
		"a parameter called in a marked function",
		"a global called in a marked function",
		"a global's method called in a marked function",
		"a builtin call no proof covers in a marked function",
		"Math.random called in a marked function",
		"a value frozen it does not build in a marked function",
		"toString called on a value in a marked function",
		"an unproven constant read in a marked function",
		"a callback literal that breaks the contract in a marked function",
		"a callback no proof covers in a marked function",
		"what a call returns called in a marked function",
		"an unlisted import called in a marked function",
		"a forbidden node in a marked function",
		"a callback literal that breaks the contract outside a marked function",
		"a callback no proof covers outside a marked function",
		"an unmarked function",
		"a misplaced mark",
		"a program of several functions"
	],
	check: (_resources, c) => (program) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(program))
			assert.deepEqual(judgedProgram(program), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the lists its module exports"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/oxlint/rules/side-effect-free.ts",
			original: '\tif (pattern.type === "MemberExpression") {\n\t\treturn [pattern]\n\t}\n',
			replacement: "",
			why: "A property assigned is read as no write; the marked-function property fails."
		},
		{
			file: "packages/devtools/src/oxlint/rules/side-effect-free.ts",
			original: '\t\t\t\t\t\tdef.type === "FunctionName" ||',
			replacement:
				'\t\t\t\t\t\tdef.type === "FunctionName" ||\n\t\t\t\t\t\tdef.type === "Parameter" ||',
			why: "A parameter called is read as a function literal it declares; the marked-function property fails."
		},
		{
			file: "packages/devtools/src/oxlint/rules/side-effect-free.ts",
			original:
				'\t\t\t\t\t\t} else if (\n\t\t\t\t\t\t\tobject.name === "Object" &&\n\t\t\t\t\t\t\tproperty === "freeze" &&\n\t\t\t\t\t\t\tcall.arguments[0]?.type !== "ObjectExpression" &&\n\t\t\t\t\t\t\tcall.arguments[0]?.type !== "ArrayExpression"\n\t\t\t\t\t\t) {\n\t\t\t\t\t\t\treportAt(\n\t\t\t\t\t\t\t\tcallee,\n\t\t\t\t\t\t\t\t"Freezes a value it may not own: it freezes only a literal the call builds."\n\t\t\t\t\t\t\t)\n',
			replacement: "",
			why: "Object.freeze of a value it does not build is admitted; the marked-function property fails."
		},
		{
			file: "packages/devtools/src/oxlint/rules/side-effect-free.ts",
			original: `\t\t\t\t\tif (Option.isNone(variable)) {\n\t\t\t\t\t\tif (!Arr.contains(CALLABLE_GLOBALS, callee.name)) {\n\t\t\t\t\t\t\treportAt(callee, \`Calls the global \${callee.name}, which no proof covers.\`)\n\t\t\t\t\t\t}\n\t\t\t\t\t} else if (`,
			replacement: "\t\t\t\t\tif (\n\t\t\t\t\t\tOption.isSome(variable) &&",
			why: "Any global called is admitted; the marked-function property fails."
		},
		{
			file: "packages/devtools/src/oxlint/rules/side-effect-free.ts",
			original: "\tisPrimitiveExpression(context, call.callee.object) &&\n",
			replacement: "",
			why: "`toString` of any value is admitted, not of a primitive alone; the marked-function property fails."
		},
		{
			file: "packages/devtools/src/oxlint/rules/side-effect-free.ts",
			original:
				"\t\t\t\t\t\tdef.node.init !== null &&\n\t\t\t\t\t\tisProvenInitializer(def.node.init)",
			replacement: "\t\t\t\t\t\tdef.node.init !== null",
			why: "A module const is read as proven whatever its value; the marked-function property fails, and the proof's-module property with it."
		},
		{
			file: "packages/devtools/src/oxlint/rules/side-effect-free.ts",
			original:
				"\t\t\t\t\t\tif (!insideMarked(call)) {\n\t\t\t\t\t\t\tprove(value, false)\n\t\t\t\t\t\t}",
			replacement: "\t\t\t\t\t\t// A function literal is its own proof.",
			why: "A call site's callback is left unproven outside a marked function; the marked-function property fails."
		}
	]
})

/** Holds a proof's own module to the claims the options make of it. */
export const proofModuleClaims = property.explore(homes, {
	needs: {},
	situations: ["a claim kept", "a claim broken"],
	check: (_resources, c) => (home) =>
		Effect.sync(() => {
			c.note(home.broken ? "a claim broken" : "a claim kept")
			assert.deepEqual(judgedHome(home), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract: a listed function is marked, a listed factory returns function literals"
	},
	kept: [],
	kills: []
})

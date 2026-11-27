/**
 * The library's lint rules (oxlint/rules), each searched over programs drawn from a grammar of its own contract: the
 * names and shapes its module exports (a clock read, a sleep, a projection, an error's name, a seeded call, a table
 * modifier, a test's options), written in every spelling the rule reads (a module path, an import alias, a namespace
 * import, a `const` that holds the value, `assert.` and `expect(…)` chains), beside their neighbours the contract leaves
 * alone (a near name, a call without its arguments, an option set to false, a sorted or a given value). Every site of a
 * program carries the number of reports the rule's stated contract gives it, and oxlint's RuleTester, run in the case
 * itself, must find exactly that many under the rule's one message.
 *
 * Oracle: the specification, each rule's JSDoc read over the lists its module exports, never a list written again
 * here. Situations, required for every rule: a site reported, a site left alone, and a program of several sites.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { placesIn } from "#mutants.fixtures.ts"
import {
	booleanSites,
	type CaseKill,
	clampedSites,
	clockCases,
	concurrencySites,
	inModule,
	inTests,
	modulePrograms,
	orderedSites,
	programOf,
	proseSites,
	retrySites,
	ruleProperty,
	seedSites,
	serializedSites,
	sleepSites,
	triggerSwitchSites,
	staleKillCases,
	staleKillJudged,
	tableSites,
	verdictPrograms,
	weightSites
} from "#oxlint/rules.fixtures.ts"
import { property } from "#property.ts"

/** no-wall-clock-verdict reports exactly the reads of the clock, the live clock's readers and timers imported among
 * them, and every finite timer a test API is given. */
export const noWallClockVerdict = ruleProperty("no-wall-clock-verdict", clockCases, [
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original:
			'\t\t\tNewExpression: (node) => {\n\t\t\t\tif (isNamed(context, node.callee, DATE_READS) && Arr.isReadonlyArrayEmpty(node.arguments)) {\n\t\t\t\t\tcontext.report({ node, messageId: "wallClock" })\n\t\t\t\t}\n\t\t\t},\n',
		replacement: "",
		why: "no-wall-clock-verdict reads `new Date()` as no read of the clock."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: "\t\t\tif (Arr.contains(LIVE_MODULES, node.source.value)) {\n",
		replacement: "\t\t\tif (false) {\n",
		why: "An import of the live clock's readers is no read of the clock, so a module outside live.ts holds one and judges by it unseen, as explore.ts's case guard raced its case against liveSleepUntil and judged the machine (QP-GATE, 2026-11-25); the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original:
			"\t\t\t\t\t\t\t(Arr.contains(LIVE_READS, importedOf(specifier)) ||\n\t\t\t\t\t\t\t\t(timersRefused && Arr.contains(LIVE_TIMERS, importedOf(specifier))))\n",
		replacement: "\t\t\t\t\t\t\tArr.contains(LIVE_READS, importedOf(specifier))\n",
		why: "A test's import of the live clock's sleep or stopwatch passes, so it races its subject against a live sleep and judges the machine, as resources.test.ts's \"never judged\" races and monitor.test.ts's 30 s did; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original:
			"\t\t\t\t!Option.exists(keyOf(node), (key) => Arr.contains(VITEST_TIMEOUTS, key)) ||\n",
		replacement: "\t\t\t\ttrue ||\n",
		why: "A finite testTimeout or hookTimeout passes, so a Vitest config fails a test by the wall clock, as qti-pie's testTimeout: 60_000 failed crust on a slow machine; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: "\tisLiteralZero(value) ||\n",
		replacement: "\tfalse ||\n",
		why: "A timeout of 0, which Vitest reads as none, is refused as finite; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: '\t\t\t\tfix: fixOf({ range: node.value.range, text: "0" })\n',
		replacement: '\t\t\t\tfix: fixOf({ range: node.range, text: "" })\n',
		why: "The fix deletes a Vitest config's testTimeout or hookTimeout, which brings back Vitest's 5 s and 10 s defaults, the wall-clock verdict the rule forbids (edullm's HANGFREE: the fix deleted qti-pie's testTimeout and crust failed at 5 s); the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original:
			'const isLiteralZero = (value: AnyNode): boolean => value.type === "Literal" && value.value === 0\n',
		replacement:
			'const isLiteralZero = (value: AnyNode): boolean =>\n\t(value.type === "Literal" && value.value === 0) || value.type === "Identifier"\n',
		why: "A timeout bound by a name, `const unbounded = 0` or `limit`, passes as none, so whether a config's timeout is none rests on a binding the rule never reads; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: "\t\t\tif (Arr.isReadonlyArrayEmpty(missing)) {\n",
		replacement: "\t\t\tif (true) {\n",
		why: "A Vitest config's test block that leaves testTimeout or hookTimeout out passes, so Vitest fails a test at 5 s and a hook at 10 s; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: "\t\treturn [...options, ...argumentTimer(context, call, 2)]\n",
		replacement: "\t\treturn [...options, ...argumentTimer(context, call, 3)]\n",
		why: "A test's or a suite's timeout argument, `it(name, fn, 60_000)`, passes; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original:
			'\t\t\t\t\tproperty.type === "Property" && Option.exists(keyOf(property), (key) => key === "timeout")\n',
		replacement:
			'\t\t\t\t\tproperty.type === "Property" && Option.exists(keyOf(property), (key) => key === "timeouts")\n',
		why: "An options object's `timeout` passes, on a test, a suite, a layer or a wait, written there or in a const; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: "\t\treturn [...options, ...argumentTimer(context, call, 1)]\n",
		replacement: "\t\treturn [...options, ...argumentTimer(context, call, 9)]\n",
		why: "A hook's timeout argument, `beforeAll(fn, 30_000)`, passes; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original:
			'\t(call.callee.type === "CallExpression" && Option.isSome(testPathOf(context, call.callee.callee)))\n',
		replacement: "\tfalse\n",
		why: "A table's test, `it.each(rows)(name, fn, 60_000)`, is no test call, so its timeout passes; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: '\t"layer",\n',
		replacement: "",
		why: "A layer's timeout, `layer(Live, { timeout: 60_000 })`, as qti-pie's pantry writes it, passes; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: '\t"vi.waitFor",\n',
		replacement: "",
		why: "A wait's timeout, `vi.waitFor(fn, { timeout })`, passes; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: "\tfixer.replaceTextRange([edit.range[0], edit.range[1]], edit.text)\n",
		replacement: "\tfixer.replaceTextRange([edit.range[0], edit.range[0]], edit.text)\n",
		why: "The fix leaves every timer where it was, so `oxlint --fix` cuts nothing over; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original: "\t\t\t\t\t\t\t\t\t\toptions === argument && options.properties.length === 1\n",
		replacement: "\t\t\t\t\t\t\t\t\t\tfalse\n",
		why: "The fix leaves an empty options object behind, `test(name, {}, fn)`; the property fails."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-wall-clock-verdict.ts",
		original:
			'\t\t\t\tonSome: (after) => ({ range: [element.range[0], after.range[0]], text: "" }),\n',
		replacement: '\t\t\t\tonSome: () => ({ range: element.range, text: "" }),\n',
		why: "A first option's deletion leaves its separator, `{ , retry: 0 }`, which no longer parses; the property fails."
	}
])

/** no-sleep-wait reports exactly the calls that wait for time to pass. */
export const noSleepWait = ruleProperty("no-sleep-wait", inTests(programOf(sleepSites)), [
	{
		file: "packages/testing/src/oxlint/rules/no-sleep-wait.ts",
		original: "\t\t\tif (isCallTo(context, node, SLEEPS)) {",
		replacement:
			'\t\t\tif (node.callee.type === "MemberExpression" && isCallTo(context, node, SLEEPS)) {',
		why: "no-sleep-wait reads a sleep called by a bare name (`setTimeout`, an import alias) as no sleep."
	}
])

/** no-trigger-switch reports exactly the SQL text that switches triggers off. */
export const noTriggerSwitch = ruleProperty(
	"no-trigger-switch",
	inTests(programOf(triggerSwitchSites)),
	[
		{
			file: "packages/testing/src/oxlint/rules/no-trigger-switch.ts",
			original: '["disable trigger", ',
			replacement: '["disable trigger user", ',
			why: "no-trigger-switch admits a trigger disabled by its name or with ALL, so a plant that names the one guard it wants gone passes."
		},
		{
			file: "packages/testing/src/oxlint/rules/no-trigger-switch.ts",
			original: "\t\t\tif (Arr.some(node.quasis, (quasi) => switches(quasi.value.raw))) {\n",
			replacement:
				"\t\t\tif (node.expressions.length === 0 && Arr.some(node.quasis, (quasi) => switches(quasi.value.raw))) {\n",
			why: "no-trigger-switch reads no template of an expression, so a switch spelled around its table's name passes."
		},
		{
			file: "packages/testing/src/oxlint/rules/no-trigger-switch.ts",
			original: ', "session_replication_role"]',
			replacement: "]",
			why: "no-trigger-switch admits the replica role, under which no ordinary trigger fires."
		},
		{
			file: "packages/testing/src/oxlint/rules/no-trigger-switch.ts",
			original: "\t\t\tblank = true\n",
			replacement: "",
			why: "no-trigger-switch reads words only as one space apart, so a switch broken over a line passes."
		}
	]
)

/** no-clamped-count reports exactly the clamping calls no count they never normalize states. */
export const noClampedCount = ruleProperty("no-clamped-count", inTests(programOf(clampedSites)), [
	{
		file: "packages/testing/src/oxlint/rules/no-clamped-count.ts",
		original:
			"\tnode !== undefined && Option.exists(writtenInteger(context, node), (count) => count >= 1)",
		replacement:
			"\tnode !== undefined && Option.exists(writtenInteger(context, node), (count) => count >= 0)",
		why: "no-clamped-count admits a count of 0 as one it never normalizes."
	}
])

/** no-implicit-weight reports exactly the choices that write an option more than once. */
export const noImplicitWeight = ruleProperty(
	"no-implicit-weight",
	inTests(programOf(weightSites)),
	[]
)

/** no-fixed-seed reports exactly the seeds written where a run or a stream takes one. */
export const noFixedSeed = ruleProperty("no-fixed-seed", inTests(programOf(seedSites)), [
	{
		file: "packages/testing/src/oxlint/rules/no-fixed-seed.ts",
		original:
			'\tif (value.type === "UnaryExpression") {\n\t\treturn value.operator === "-" && isFixed(context, value.argument)\n\t}\n',
		replacement: "",
		why: "no-fixed-seed reads a negated literal seed as no fixed seed."
	}
])

/** no-boolean-assert reports exactly the boolean assertions a narrower one states, with no message. */
export const noBooleanAssert = ruleProperty("no-boolean-assert", inTests(programOf(booleanSites)), [
	{
		file: "packages/testing/src/oxlint/rules/no-boolean-assert.ts",
		original:
			"\tassertion.subjects.length > (Arr.contains(TRUTHS, assertion.name) ? 1 : 2) ||\n\tOption.isSome(expectMessageOf(context, node))",
		replacement: "\tassertion.subjects.length > (Arr.contains(TRUTHS, assertion.name) ? 1 : 2)",
		why: "no-boolean-assert reads the message of an `expect(actual, message)` chain as none."
	}
])

/** no-error-prose reports exactly the assertions of an error's text. */
export const noErrorProse = ruleProperty("no-error-prose", inTests(programOf(proseSites)), [
	{
		file: "packages/testing/src/oxlint/rules/no-error-prose.ts",
		original: "\tArr.some(ERROR_SUFFIXES, (suffix) => Str.endsWith(suffix)(name))",
		replacement: "\tArr.some(ERROR_SUFFIXES, (suffix) => suffix === name)",
		why: "no-error-prose takes an error's ending for a whole name, so the text of a name ending in one (`parseError.message`) is no error's text; no-serialized-comparison, which leaves error text to no-error-prose, goes red with it."
	}
])

/** no-serialized-comparison reports exactly the comparisons through text. */
export const noSerializedComparison = ruleProperty(
	"no-serialized-comparison",
	inTests(programOf(serializedSites)),
	[
		{
			file: "packages/testing/src/oxlint/rules/no-error-prose.ts",
			original: "\tArr.some(ERROR_SUFFIXES, (suffix) => Str.endsWith(suffix)(name))",
			replacement: "\tArr.some(ERROR_SUFFIXES, (suffix) => suffix === name)",
			why: "no-error-prose takes an error's ending for a whole name, so the text of a name ending in one (`parseError.message`) is no error's text; no-serialized-comparison, which leaves error text to no-error-prose, goes red with it."
		},
		{
			file: "packages/testing/src/oxlint/rules/no-serialized-comparison.ts",
			original:
				"\t\t(isCallTo(context, value, SERIALIZATIONS) || isToString(value)) && !isErrorText(context, value)",
			replacement: "\t\tisCallTo(context, value, SERIALIZATIONS) && !isErrorText(context, value)",
			why: "no-serialized-comparison reads `toString()` as no serialization."
		}
	]
)

/** no-ordered-unordered reports exactly the ordered equalities over an unordered collection's order. */
export const noOrderedUnordered = ruleProperty(
	"no-ordered-unordered",
	inTests(programOf(orderedSites)),
	[
		{
			file: "packages/testing/src/oxlint/rules/no-ordered-unordered.ts",
			original:
				'\tif (isProjection(context, node)) {\n\t\treturn true\n\t}\n\tif (node.type === "ObjectExpression") {\n\t\treturn Arr.some(\n\t\t\tnode.properties,\n\t\t\t(property) => property.type === "Property" && holdsProjection(context, property.value)\n\t\t)\n\t}\n\treturn (\n\t\tnode.type === "ArrayExpression" &&\n\t\tArr.some(\n\t\t\tnode.elements,\n\t\t\t(element) =>\n\t\t\t\telement !== null && element.type !== "SpreadElement" && holdsProjection(context, element)\n\t\t)\n\t)',
			replacement: "\treturn isProjection(context, node)",
			why: "no-ordered-unordered reads a projection held in an object literal's field or an array literal's item as no projection."
		},
		{
			file: "packages/testing/src/oxlint/rules/no-ordered-unordered.ts",
			original: "\tconst node = valueOf(context, compared)",
			replacement: "\tconst node = compared",
			why: "no-ordered-unordered reads a projection held by a `const` and compared as no projection."
		}
	]
)

/** no-example-table reports exactly the tables of rows written in source, in whatever function a test runs as its body. */
export const noExampleTable = ruleProperty("no-example-table", inTests(programOf(tableSites)), [
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original:
			"\t\tTaggedTemplateExpression: (node) => {\n\t\t\tif (Option.exists(testPathOf(context, node.tag), isTablePath)) {\n\t\t\t\trefuse(node)\n\t\t\t}\n\t\t},\n",
		replacement: "",
		why: "no-example-table reads a tagged-template table as no table."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original: "\t\tArr.isReadonlyArrayNonEmpty(value.elements) ||\n",
		replacement: "\t\ttrue ||\n",
		why: "An empty array is read as rows: an accumulator a property fills at run time (edullm's journey.test.ts `journeyNotes`) is refused as an example table."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original:
			"\t\t\tArr.some(variable.references, (reference) => pushesWritten(reference.identifier))\n",
		replacement: "\t\t\tfalse\n",
		why: "Rows a test pushes are no rows: `const t = []; t.push({ input: 1 })` and a loop over `t` pass as no table."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original: "\tOption.exists(testPathOf(context, call.callee), (path) => !isTablePath(path))\n",
		replacement: "\tOption.exists(testPathOf(context, call.callee), (path) => isTablePath(path))\n",
		why: "A test's own callback is no body: a for…of over written rows straight in `it(..., () => { ... })` passes."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original: "\t\treturn parent.body === node && runsAsBody(context, parent, seen)\n",
		replacement: "\t\treturn false\n",
		why: "The generator of an `Effect.gen` a test's arrow returns is no body: `it.effect(..., () => Effect.gen(function* () { for … }))` passes."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original: "\t\t\t(isTestCall(context, parent) || runsAsBody(context, parent, seen))\n",
		replacement: "\t\t\tisTestCall(context, parent)\n",
		why: 'A wrapper hands no function on: the generator of `Effect.fn("name")(function* (ctx) { … })` handed a test as its body, qti-pie pantry\'s blind spot, passes, as does an `Effect.gen` under `Effect.scoped`.'
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original: "\t\t\tparent.object === node &&\n",
		replacement: "\t\t\tfalse &&\n",
		why: "An effect piped on is no body: the generator of `Effect.gen(function* () { for … }).pipe(Effect.scoped)` a test's arrow returns passes, as 28 of qti-pie's reported tables would."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original:
			"\t\t\t(reference) => reference.isRead() && runsAsBody(context, reference.identifier, held)\n",
		replacement: "\t\t\t(reference) => false\n",
		why: 'A body a `const` holds is no body: `const body = Effect.fn("name")(function* (ctx) { for … })` handed a test as `it.effect(..., body)` passes.'
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original: "\t\t(!Arr.contains(FUNCTIONS, node.type) &&\n",
		replacement: "\t\t(false &&\n",
		why: "A body's declaration runs nothing: the generator of an `Effect.gen` a declaration of a test's callback runs (`const ran = Effect.runSync(Effect.gen(function* () { for … }))`) passes."
	},
	{
		file: "packages/testing/src/oxlint/rules/no-example-table.ts",
		original: '\t"ExpressionStatement",\n',
		replacement: "",
		why: "A body's statement runs nothing: the generator of an `Effect.gen` a statement of a test's callback runs (`Effect.runSync(Effect.gen(function* () { for … }))`) passes."
	}
])

/** no-retry-or-concurrency reports exactly each retry and each concurrency of a test. */
export const noRetryOrConcurrency = ruleProperty(
	"no-retry-or-concurrency",
	inTests(programOf(retrySites)),
	[
		{
			file: "packages/testing/src/oxlint/rules/no-retry-or-concurrency.ts",
			original:
				"\t\t...Arr.filter(propertiesNamed(options, CONCURRENT), (property) => !isFalse(property.value))",
			replacement:
				"\t\t...Arr.filter(propertiesNamed(options, CONCURRENT), (property) => !isFalse(property))",
			why: "no-retry-or-concurrency refuses `concurrent: false`, which runs no test beside another."
		}
	]
)

/** test-module-shape reports exactly each top-level statement that is no import, type or exported property. */
export const testModuleShape = ruleProperty("test-module-shape", inModule(modulePrograms), [])

/** no-verdict-table reports exactly the tables of written verdicts outside a dictionary door. */
export const noVerdictTable = ruleProperty("no-verdict-table", inTests(verdictPrograms), [])

/** no-restated-concurrency reports and deletes exactly each default width written out. */
export const noRestatedConcurrency = ruleProperty(
	"no-restated-concurrency",
	inTests(programOf(concurrencySites)),
	[]
)

/**
 * no-stale-kill reports exactly the kills a test module states that a mutation run would find stale: each whose file
 * the checkout does not hold, or whose original stands in its file other than once, overlapping places counted.
 */
export const noStaleKill = property.explore(staleKillCases, {
	needs: {},
	situations: [
		"a kill stale where its original stands nowhere",
		"a kill stale where its original stands more than once",
		"a kill stale where its file is not in the checkout",
		"a kill whose original stands once"
	],
	check: (_resources, c) => (staleKillCase) =>
		Effect.gen(function* () {
			const text = Arr.join(staleKillCase.parts, "")
			const places = (kill: CaseKill) => placesIn(text, kill.original).length
			for (const kill of staleKillCase.kills) {
				c.note(
					!kill.held
						? "a kill stale where its file is not in the checkout"
						: places(kill) === 0
							? "a kill stale where its original stands nowhere"
							: places(kill) === 1
								? "a kill whose original stands once"
								: "a kill stale where its original stands more than once"
				)
			}
			const judged = yield* staleKillJudged(
				staleKillCase,
				(kill) => !kill.held || places(kill) !== 1
			)
			assert.deepEqual(judged, Option.none())
		}),
	oracle: {
		kind: "second-implementation",
		name: "a kill is stale where its file is absent or where its original stands other than once, its places found by splitting the text at every offset"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/oxlint/rules/no-stale-kill.ts",
			original: "onNone: () => Result.fail(killMissing(kill.value)),",
			replacement: 'onNone: () => Result.succeed(""),',
			why: "A kill naming a file the checkout does not hold passes the rule, which a mutation run finds stale."
		}
	]
})

/**
 * The workspace gate's core-lint rule (src/workspace/core-lint.ts), exhausted over the configurations its contract
 * tells apart (core-lint.fixtures.ts, src/workspace/fixtures/core-lint): one on another preset, which loads no dev tools
 * plugin; one that loads the plugin by a relative path and holds two core rules, one other off and one a warning; one
 * that loads it under a name of its own, oxlint's `{ name, specifier }` entry as ultracite writes it, beside a plugin
 * named by its package, an entry of text, and holds the same two (qti-pie's configuration failed edullm's gate at every
 * toolchain while the reader took plugin entries for texts alone, 2026-11-26); one that names the plugin and the core
 * rules by hand as they stood before the toolchain added no-variadic-callback; one that turns on rules of built-in
 * plugins it does not load, jsdoc's and promise's at its top and react's in an override that loads vitest (edullm-bd,
 * 2026-11-27: jsdoc/check-tag-names and promise/prefer-await-to-then named on a preset that loaded neither); and one the
 * preset's standard builds. Each is resolved by oxlint itself (`--print-config`), and the rule must find exactly what it
 * lacks of the core set: the plugin where it loads none, every core rule it holds at less than error, and every rule it
 * turns on that no plugin it loads runs; the preset's nothing.
 *
 * Oracle: the specification, the rule's JSDoc read over the preset's CORE_RULES.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { CORE_RULES } from "#preset.ts"
import { coreConfigurations, expectedOf, fileOf } from "#workspace/core-lint.fixtures.ts"
import { coreFaults, coreLintFindings, judgedConfiguration } from "#workspace/core-lint.ts"

/** The core lint set holds a configuration exactly where oxlint resolves it to load the plugin and every core rule. */
export const coreLintSetHeld = property.exhaust(coreConfigurations, {
	box: "a configuration on another preset, a partial one, one loading the plugin under a name of its own beside a plugin named by its package, a hand-wired one missing the newest core rule, one turning on rules of built-in plugins it does not load, and the preset's",
	needs: {},
	situations: [],
	check: () => (configuration) =>
		Effect.gen(function* () {
			const judged = yield* judgedConfiguration(
				`${import.meta.dirname}/../..`,
				fileOf(configuration)
			)
			const expected = expectedOf(configuration)
			assert.deepEqual(coreFaults(judged, CORE_RULES), expected)
			assert.equal(
				coreLintFindings([judged], CORE_RULES).length,
				(expected.noPlugin ? 1 : 0) +
					(expected.missing.length > 0 ? 1 : 0) +
					(expected.silent.length > 0 ? 1 : 0)
			)
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the preset's CORE_RULES, each configuration resolved by oxlint"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/workspace/core-lint.ts",
			original: '\treturn level === "deny" || level === "error" || level === 2\n',
			replacement: "\treturn level !== undefined\n",
			why: "A core rule held at less than error reads as held: the partial configuration's no-spread-argument, a warning, is no fault."
		},
		{
			file: "packages/devtools/src/workspace/core-lint.ts",
			original: "\t\t\tloadsPlugin: plugin !== undefined && Arr.contains(loaded, plugin),\n",
			replacement: "\t\t\tloadsPlugin: true,\n",
			why: "A configuration that loads no dev tools plugin passes the plugin's check: the bare one, on another preset, is refused only for its rules."
		},
		{
			file: "packages/devtools/src/workspace/core-lint.ts",
			original:
				"\tSchema.String,\n\tSchema.Struct({ name: Schema.String, specifier: Schema.String })\n",
			replacement: "\tSchema.String\n",
			why: "A plugin entry of oxlint's `{ name, specifier }` form is no entry the reader decodes: the aliased configuration's resolution is refused as no configuration the gate reads, as qti-pie's was."
		},
		{
			file: "packages/devtools/src/workspace/core-lint.ts",
			original: '\t\t\tpath.isAbsolute(specifier) || Str.startsWith(".")(specifier)\n',
			replacement: "\t\t\tpath.isAbsolute(specifier)\n",
			why: "A plugin a configuration loads by a path relative to its directory is no plugin to the rule: the partial and hand-wired configurations are refused as loading none."
		},
		{
			file: "packages/devtools/src/workspace/core-lint.ts",
			original:
				"\t\t\tArr.dedupe(Arr.filter(statedOn(stated), (rule) => !Arr.contains(resolvedRules, rule))),\n",
			replacement: "\t\t\tArr.dedupe(Arr.filter(statedOn(stated), () => false)),\n",
			why: "A rule named for a built-in plugin the configuration does not load reads as one that runs: the silent configuration's jsdoc, promise and react rules, which oxlint drops from its resolution and never runs, are no fault."
		},
		{
			file: "packages/devtools/src/workspace/core-lint.ts",
			original: "\t...Arr.flatMap(stated.overrides ?? [], (override) => onIn(override.rules)),\n",
			replacement: "",
			why: "A configuration's overrides state no rule to the check: the silent configuration's override's react rule, which oxlint drops as its top's, is no fault."
		}
	]
})

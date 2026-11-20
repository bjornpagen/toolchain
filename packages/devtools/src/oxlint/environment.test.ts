/**
 * The environment's os ban (src/oxlint/environment.ts ENVIRONMENT_IMPORTS): a library module may import Node's os
 * module's constants table, the platform's numbers, which read no environment, and may import no other value of it.
 *
 * osImportsHeld exhausts its box (environment.fixtures.ts): either of os's specifiers, each way a module takes some of
 * its exports (by name, as a re-export, as a type, through the default export or the namespace) and each non-empty set
 * of three of them, the constants table and two values that read the machine (`cpus`, `hostname`). Each case's module
 * is written into a library directory of its own and linted by oxlint under the no-restricted-imports rule the preset
 * builds for a library file. The codes oxlint reports must be the import ban's wherever the module takes a value of os
 * that is not the constants table, and none where it takes the table alone or only types.
 *
 * Oracle: the specification, the environment's JSDoc for its os ban.
 */
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect, type Option } from "effect"
import {
	osImports,
	osRefusalsOf,
	osFeaturesOf,
	osReportedOf
} from "#oxlint/environment.fixtures.ts"

/** Hold each module's import of os to the codes the contract gives it. */
export const osImportsHeld = property.exhaust(finite(osImports), {
	box: "either specifier of os, each way a module takes its exports, and each non-empty set of its constants table, cpus and hostname",
	needs: { dir: Scratch.dir },
	situations: [
		"an import of the constants table alone",
		"an import of a value that reads the machine",
		"the default export or the namespace",
		"a type import",
		"the bare specifier"
	],
	check:
		({ dir }, c) =>
		(cell) =>
			Effect.gen(function* () {
				c.noteAll(osFeaturesOf(cell))
				const scratch = yield* dir
				const reported: ReadonlyArray<Option.Option<string>> = yield* osReportedOf(scratch, cell)
				assert.deepEqual(reported, osRefusalsOf(cell))
			}),
	oracle: { kind: "specification", name: "the environment's stated contract for its os ban" },
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/oxlint/environment.ts",
			original: "\t\t\tallowImportNames: OS_CONSTANTS,\n",
			replacement: "",
			why: "The os module is banned whole, as it was, so a library that names a signal by `constants.signals` must be an environment reader (grizzle's call-error.ts); the osImports of the constants table alone fail."
		},
		{
			file: "packages/devtools/src/oxlint/environment.ts",
			original: "\t\t\tallowImportNames: OS_CONSTANTS,",
			replacement: '\t\t\timportNames: ["cpus", "totalmem", "freemem"],',
			why: "Only some of the values that read the machine are named, so `hostname` and the default import pass; the osImports that read hostname or take the default export fail."
		},
		{
			file: "packages/devtools/src/oxlint/environment.ts",
			original: 'const OS_CONSTANTS: ReadonlyArray<string> = ["constants"]',
			replacement: 'const OS_CONSTANTS: ReadonlyArray<string> = ["constants", "default"]',
			why: "The default import is admitted as if it were the constants table, so `os.cpus()` through it passes; the default-export osImports fail."
		}
	]
})

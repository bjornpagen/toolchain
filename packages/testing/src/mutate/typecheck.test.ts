/**
 * A mutant's typecheck (mutate/typecheck.ts): a mutant is invalid exactly when it makes a type error the unmutated
 * package does not have, in its own file or in any file whose types read it, through value imports and `import type`
 * alike and at any depth; a file that reads nothing of it is never checked against it, nor are its readers when it
 * keeps its file's surface; a file a verdict reads that holds an error unmutated refuses the run, and one no verdict
 * reads never does; and a mutant leaves nothing behind it, so the user's file checked as it is next is valid.
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { realPathOf } from "#mutate/mutated.ts"
import {
	edgesTo,
	type Expected,
	expectedOf,
	filesOf,
	mutantText,
	packageGen
} from "#mutate/typecheck.fixtures.ts"
import { TypecheckRefused, typecheckerOf } from "#mutate/typecheck.ts"
import { property } from "#property.ts"

export const mistypedMutants = property.explore(packageGen, {
	needs: {},
	situations: [
		"the mutant's own file",
		"a reader two imports away",
		"a value import on the way",
		"a type import on the way",
		"a stranger",
		"a mutant that keeps its file's surface",
		"a file the verdict reads holds an error",
		"a file no verdict reads holds an error"
	],
	check: (_resources, c) => (pkg) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-typecheck-test-" })
			const root = yield* realPathOf(made)
			const files: ReadonlyArray<readonly [string, string]> = [
				["package.json", `{"type":"module"}`],
				[
					"tsconfig.json",
					`{"compilerOptions":{"strict":true,"noEmit":true,"target":"esnext","module":"nodenext","allowImportingTsExtensions":true,"types":[],"lib":["esnext"]},"include":["*.ts"]}`
				],
				...filesOf(pkg)
			]
			for (const [file, text] of files) {
				yield* fs.writeFileString(path.join(root, file), text)
			}
			const edges = edgesTo(pkg)
			if (pkg.user === 0) {
				c.note("the mutant's own file")
			}
			if (edges.length >= 2) {
				c.note("a reader two imports away")
			}
			for (const edge of edges) {
				c.note(edge === "value" ? "a value import on the way" : "a type import on the way")
			}
			if (pkg.user === -1) {
				c.note("a stranger")
			}
			if (pkg.mutation !== "declaration") {
				c.note("a mutant that keeps its file's surface")
			}
			const expected = expectedOf(pkg)
			if (expected.kind === "refused") {
				c.note("a file the verdict reads holds an error")
			} else if (pkg.broken) {
				c.note("a file no verdict reads holds an error")
			}
			const mistyped = yield* typecheckerOf(root)
			const target = yield* realPathOf(path.join(root, "f0.ts"))
			const typed = yield* Effect.result(mistyped({ target, text: mutantText(pkg) }))
			const judged: Expected =
				typed._tag === "Failure" ? { kind: "refused" } : { kind: "judged", invalid: typed.success }
			deepStrictEqual(
				{
					judged,
					refusal: typed._tag === "Failure" && Schema.is(TypecheckRefused)(typed.failure)
				},
				{ judged: expected, refusal: expected.kind === "refused" }
			)
			if (!pkg.broken) {
				const userFile = pkg.user === -1 ? "stranger.ts" : `f${String(pkg.user)}.ts`
				const user = yield* realPathOf(path.join(root, userFile))
				const userText = yield* fs.readFileString(user)
				const after = yield* mistyped({ target: user, text: userText })
				deepStrictEqual({ after }, { after: false })
			}
		}),
	oracle: {
		kind: "specification",
		name: "refused exactly when a file the verdict reads holds an error unmutated; else invalid exactly when the mutant breaks its own file, or changes its surface and a file that reads it uses the type as a number"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "pending.push(importer)",
			replacement: "pending.length = 0",
			why: "Only a file's direct importers are its readers, so a mutant that breaks a file two imports away is judged valid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "const readersErrors = yield* errorsOf(program, file, readers)",
			replacement: "const readersErrors = yield* errorsOf(program, file, [file])",
			why: "Only the mutant's own file is checked, so a mutant whose type error stands in a reader is judged valid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "Option.isSome(before) && Option.isSome(after) && before.value === after.value",
			replacement: "true",
			why: "Every mutant is taken to keep its file's surface, so one that changes a declaration's type and breaks a reader is judged valid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "if (Arr.isReadonlyArrayNonEmpty(typeErrorsIn(errors))) {",
			replacement: "if (Arr.isReadonlyArrayNonEmpty(typeErrorsIn([]))) {",
			why: "A mutant's own file is never read for its errors, so a mistyped body behind an annotated declaration, its surface kept, is judged valid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "if (Arr.isReadonlyArrayNonEmpty(unmutatedErrors)) {",
			replacement: "if (Arr.isReadonlyArrayNonEmpty([])) {",
			why: "A reader's errors are never read again unmutated, so a reader that held its error before the mutant makes the mutant invalid instead of refusing the run."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "const restored = yield* succeeded(mutant, mutated.target, unmutated.text)",
			replacement: "const restored = mutant",
			why: "The live snapshot keeps a mutant's text after its check, so the next check of another file reads the mutant's error."
		}
	]
})

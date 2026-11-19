/**
 * A mutant's typecheck (mutate/typecheck.ts): a mutant is invalid exactly when it makes a type error the unmutated
 * package does not have, in its own file or in any file whose types read it, through value imports and `import type`
 * alike and at any depth; a file that reads nothing of it is never checked against it, nor are its readers when it
 * keeps its file's surface; errors the unmutated package already has (a ratchet's) change no verdict; and a mutant
 * leaves nothing behind it, so the user's file checked as it is next is valid.
 */
import { Effect, FileSystem, Path } from "effect"
import { assert } from "#assert.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { edgesTo, filesOf, invalidOf, mutantText, packageGen } from "#mutate/typecheck.fixtures.ts"
import { typecheckerOf } from "#mutate/typecheck.ts"
import { property } from "#property.ts"

export const mistypedMutants = property.explore(packageGen, {
	needs: {},
	situations: [
		"the mutant's own file",
		"a broken reader two imports away",
		"a broken reader through a value import",
		"a broken reader through a type import",
		"a stranger",
		"a mutant that keeps its file's surface",
		"a mutant that changes its surface and breaks nothing",
		"a reader its surface reaches held an error unmutated",
		"the mutant's own file held an error unmutated"
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
			const surfaced = pkg.mutation === "declaration" || pkg.mutation === "literal"
			if (pkg.user === 0) {
				c.note("the mutant's own file")
			}
			if (pkg.mutation === "declaration" && edges.length >= 2) {
				c.note("a broken reader two imports away")
			}
			for (const edge of pkg.mutation === "declaration" ? edges : []) {
				c.note(
					edge === "value"
						? "a broken reader through a value import"
						: "a broken reader through a type import"
				)
			}
			if (pkg.user === -1) {
				c.note("a stranger")
			}
			if (!surfaced) {
				c.note("a mutant that keeps its file's surface")
			}
			if (pkg.mutation === "literal") {
				c.note("a mutant that changes its surface and breaks nothing")
			}
			if (pkg.broken && surfaced && pkg.user > 0) {
				c.note("a reader its surface reaches held an error unmutated")
			}
			if (pkg.broken && pkg.user === 0) {
				c.note("the mutant's own file held an error unmutated")
			}
			const mistyped = yield* typecheckerOf(root)
			const target = yield* realPathOf(path.join(root, "f0.ts"))
			const invalid = yield* mistyped({ target, text: mutantText(pkg) })
			const userFile = pkg.user === -1 ? "stranger.ts" : `f${String(pkg.user)}.ts`
			const user = yield* realPathOf(path.join(root, userFile))
			const userText = yield* fs.readFileString(user)
			const after = yield* mistyped({ target: user, text: userText })
			assert.deepEqual({ invalid, after }, { invalid: invalidOf(pkg), after: false })
		}),
	oracle: {
		kind: "specification",
		name: "invalid exactly when the mutant breaks its own file, or changes its surface and a file that reads it uses the type as a number, whatever errors the user's file held unmutated"
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
			original: "if (adds(unmutated.errors, typeErrorsIn(errors))) {",
			replacement: "if (adds(unmutated.errors, typeErrorsIn([]))) {",
			why: "A mutant's own file is never read for its errors, so a mistyped body behind an annotated declaration, its surface kept, is judged valid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "if (adds(unmutated.errors, typeErrorsIn(errors))) {",
			replacement: "if (adds(new Map(), typeErrorsIn(errors))) {",
			why: "The mutant's own file is judged against no errors, so a file that held an error unmutated makes every mutant of it invalid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "adds(countedOf(before), found.errors)",
			replacement: "adds(new Map(), found.errors)",
			why: "A reader's errors are judged against no errors, so a reader that held an error unmutated makes a mutant whose surface reaches it invalid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "const restored = yield* succeeded(mutant, mutated.target, unmutated.text)",
			replacement: "const restored = mutant",
			why: "The live snapshot keeps a mutant's text after its check, so the next check of another file reads the mutant's error."
		}
	]
})

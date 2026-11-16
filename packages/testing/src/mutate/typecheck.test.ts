/**
 * A mutant's typecheck (mutate/typecheck.ts): a mutant is invalid exactly when it makes a type error the unmutated
 * package does not have, in its own file or in any file whose types read it, through value imports and `import type`
 * alike and at any depth; a file that reads nothing of it is never checked against it; and a mutant leaves nothing
 * behind it, so the user's file checked as it is next is valid. The check reads only the mutant's file and its readers,
 * so a reader it misses is a mistyped mutant judged valid.
 */
import { Effect, FileSystem, Path } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { edgesTo, filesOf, packageGen, rootText } from "#mutate/typecheck.fixtures.ts"
import { typecheckerOf } from "#mutate/typecheck.ts"
import { property } from "#property.ts"

export const mistypedMutants = property.explore(packageGen, {
	needs: {},
	situations: [
		"the mutant's own file",
		"a reader two imports away",
		"a value import on the way",
		"a type import on the way",
		"a stranger"
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
			const mistyped = yield* typecheckerOf(root)
			const target = yield* realPathOf(path.join(root, "f0.ts"))
			const invalid = yield* mistyped({ target, text: rootText(pkg, '"one"') })
			const userFile = pkg.user === -1 ? "stranger.ts" : `f${String(pkg.user)}.ts`
			const user = yield* realPathOf(path.join(root, userFile))
			const userText = yield* fs.readFileString(user)
			const after = yield* mistyped({ target: user, text: userText })
			deepStrictEqual({ invalid, after }, { invalid: pkg.user !== -1, after: false })
		}),
	oracle: {
		kind: "specification",
		name: "invalid exactly when the file that uses the type as a number reads the mutant's file, by any import at any depth"
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
			original: "...typed.getSemanticDiagnostics(readers(mutated.target))",
			replacement: "...typed.getSemanticDiagnostics(mutated.target)",
			why: "Only the mutant's own file is checked, so a mutant whose type error stands in a reader is judged valid."
		},
		{
			file: "packages/testing/src/mutate/typecheck.ts",
			original: "const restored = yield* succeeded(mutant, mutated.target, own)",
			replacement: "const restored = mutant",
			why: "The live snapshot keeps a mutant's text after its check, so the next check of another file reads the mutant's error."
		}
	]
})

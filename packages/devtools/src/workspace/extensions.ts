import { Array as Arr, Effect, Result, String as Str } from "effect"
import type { Finding } from "#shared/finding.ts"
import { gitFilesUnder } from "#shared/git.ts"
import { Repository } from "#shared/repository.ts"

/** JavaScript's own extensions. */
const JAVASCRIPT_EXTENSIONS: ReadonlyArray<string> = [".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

/** Every file git shows that holds code is TypeScript: a JavaScript extension is refused. */
export const tsOnlyExtensionFindings = Effect.gen(function* () {
	const { root } = yield* Repository
	const files = yield* gitFilesUnder(root)
	return Arr.filterMap(files, (file): Result.Result<Finding, void> =>
		Arr.some(JAVASCRIPT_EXTENSIONS, (extension) => Str.endsWith(extension)(file))
			? Result.succeed({
					file,
					line: 1,
					column: 1,
					rule: "ts-only-extensions",
					message: "Source files are TypeScript: give this file a .ts or .tsx extension."
				})
			: Result.failVoid
	)
})

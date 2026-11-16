import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"

/**
 * The module hook of a worker started for one mutant, which the worker runs before anything else it loads (an
 * `--import` of the data: URL hookedImage gives it, image.ts): from then on every import and require of the mutant's
 * file `target` in the worker loads the mutated text, read once from `textFile`, in the format Node gives the file
 * itself, so the worker's own modules and the cases' see one mutant alike; every other module loads as it is. It
 * imports nothing but Node's own modules, so no module of the repository loads before the hook is in place.
 */
export const serve = (target: string, textFile: string): void => {
	const url = pathToFileURL(target).href
	const text = process.getBuiltinModule("node:fs").readFileSync(textFile, "utf8")
	registerHooks({
		load: (loaded, context, nextLoad) => {
			const unmutated = nextLoad(loaded, context)
			return loaded === url
				? { format: unmutated.format, source: text, shortCircuit: true }
				: unmutated
		}
	})
}

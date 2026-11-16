import type { Plugin } from "#codemod/plugin.ts"
import { ambient, provisionsBy, unwrapsNothing } from "#codemod/plugins/shared.ts"

/**
 * den (github.com/bjornpagen/den): its packages' test trees; `exploration` (den-model's search.ts and edullm's
 * test/support/search.ts) is a spec builder whose defaults are runner Limits now. The integration slice (sliceLayer) is
 * lane DEN-SLICE's template, so its files are left with their reason.
 */
export const den: Plugin = {
	include: ["packages/**/*.test.ts"],
	provision: provisionsBy([
		...ambient,
		["Digest.layerWebCrypto", { kind: "layer", text: "Digest.layerWebCrypto" }]
	]),
	stages: [],
	builders: [
		{ module: "#search.ts", name: "exploration" },
		{ module: "@den/model/search", name: "exploration" },
		{ module: "#test/support/search.ts", name: "exploration" },
		{ module: "./support/search.ts", name: "exploration" }
	],
	unwrap: unwrapsNothing
}

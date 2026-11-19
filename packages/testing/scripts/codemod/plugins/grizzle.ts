import type { Plugin, Provision } from "#codemod/plugin.ts"
import { ambient, provisionsBy, unwrapsNothing } from "#codemod/plugins/shared.ts"

/**
 * grizzle's Substrate, as each case's own, in the form the layer's database was: a file-wide shared database
 * (Substrate.layer), which every case and every file on the worker shared, is the worker's own clone held across its
 * cases, each case's allocations released after it (`Substrate.installing`); a file's isolated database
 * (Substrate.isolatedLayer), for a file that changes the database itself, is a clone of the case's own
 * (`Substrate.fresh`). Each is a Need of a Substrate (test/support/substrate/substrate.ts), and the check provides it as
 * the Substrate service to what it runs, so the property's body and every support helper it calls read
 * `yield* Substrate` as before.
 */
const substrateOf = (need: "Substrate.installing" | "Substrate.fresh"): Provision => ({
	kind: "need",
	resource: "substrate",
	need,
	service: "Substrate",
	imports: []
})

/** grizzle (github.com/bjornpagen/grizzle): its test tree, its Substrate and the platform's layers. */
export const grizzle: Plugin = {
	include: ["test/**/*.test.ts"],
	provision: provisionsBy([
		...ambient,
		["Substrate.layer", substrateOf("Substrate.installing")],
		["Substrate.isolatedLayer", substrateOf("Substrate.fresh")],
		["spawner", { kind: "ambient" }],
		["Digest.layerWebCrypto", { kind: "layer", text: "Digest.layerWebCrypto" }]
	]),
	stages: ["withLayer"],
	builders: [],
	unwrap: unwrapsNothing
}

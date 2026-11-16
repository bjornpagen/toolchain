import type { Plugin, Provision } from "#codemod/plugin.ts"
import { ambient, provisionsBy, unwrapsNothing } from "#codemod/plugins/shared.ts"

/**
 * grizzle's Substrate, as each case's own: `Substrate.fresh` (test/support/substrate/substrate.ts, a grizzle
 * conversion lane's) is a Need of a Substrate over the case's own database, cloned from grizzle_template through
 * RESOURCES' Database.fresh, and the check provides it as the Substrate service to what it runs, so the property's body
 * and every support helper it calls read `yield* Substrate` as before. A file-wide shared database and a file's
 * isolated one both become the case's own.
 */
const substrate: Provision = {
	kind: "need",
	resource: "substrate",
	need: "Substrate.fresh",
	service: "Substrate",
	imports: []
}

/** grizzle (github.com/bjornpagen/grizzle): its test tree, its Substrate and the platform's layers. */
export const grizzle: Plugin = {
	include: ["test/**/*.test.ts"],
	provision: provisionsBy([
		...ambient,
		["Substrate.layer", substrate],
		["Substrate.isolatedLayer", substrate],
		["spawner", { kind: "ambient" }],
		["Digest.layerWebCrypto", { kind: "layer", text: "Digest.layerWebCrypto" }]
	]),
	stages: ["withLayer"],
	builders: [],
	unwrap: unwrapsNothing
}

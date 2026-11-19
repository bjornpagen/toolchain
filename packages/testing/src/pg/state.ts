import { Array as Arr, Config, Effect, Schema } from "effect"
import type { ClusterPort, LocalCluster } from "#pg/spec.ts"

/**
 * One member of a cluster as its state directory holds it: its port, its own name, and the paths in its state directory
 * (make.ts fills them, destroy removes them whole): the data directory; the TLS material (the local CA, the server's
 * certificate it signed, and an unrelated CA for the refusal checks); the server's log; its Unix socket's directory,
 * where the bootstrap superuser connects by peer authentication; and the owner's password.
 */
export type MemberState = Readonly<{
	port: number
	state: string
	data: string
	tls: string
	log: string
	socket: string
	passwordFile: string
}>

/**
 * A cluster's state, keyed by its name (ClusterPort) under the user's `$HOME/.local/var/toolchain-pg`: its directory,
 * which holds each member's state directory, named by the member's port, and the cluster's manifest (Manifest); and the
 * file that locks its lifecycle, beside the directory, so it outlives a destroyed cluster and every checkout of every
 * repository that names the port locks the same file.
 */
export type ClusterState = Readonly<{
	port: ClusterPort
	base: string
	root: string
	manifest: string
	lock: string
	member: (port: number) => MemberState
}>

/** The directory every local cluster's state lies under, in the user's home (HOME). */
const stateBase = Effect.map(
	Effect.orDie(Config.String("HOME")),
	(home) => `${home}/.local/var/toolchain-pg`
)

/** The state of the cluster named `port`: its directory, manifest and lock, and each member's directory in it. */
export const clusterState = (port: ClusterPort): Effect.Effect<ClusterState> =>
	Effect.map(stateBase, (base) => {
		const root = `${base}/${port}`
		return {
			port,
			base,
			root,
			manifest: `${root}/cluster.json`,
			lock: `${base}/${port}.lock`,
			member: (memberPort) => {
				const state = `${root}/${memberPort}`
				return {
					port: memberPort,
					state,
					data: `${state}/data`,
					tls: `${state}/tls`,
					log: `${state}/log`,
					socket: `${state}/socket`,
					passwordFile: `${state}/owner.password`
				}
			}
		}
	})

/** An extension as a manifest records it. */
const Extension = Schema.Struct({ name: Schema.String, schema: Schema.String })

/**
 * What a cluster was made as, written once its every member exists and read by every command and need that reaches it:
 * the server's version (`postgres --version` of the bin that made it, so a repinned server is refused rather than run
 * over data another made), the owner, the template and its extensions, the durability, and its members' ports in
 * member order, the first the cluster's name. A member's port is whatever port was free when it was made, so every
 * reader of the family reads it here, never a formula.
 */
const Manifest = Schema.Struct({
	server: Schema.String,
	owner: Schema.String,
	template: Schema.String,
	extensions: Schema.Array(Extension),
	peerLogins: Schema.Array(Schema.String),
	durability: Schema.Literals(["throwaway", "kept"]),
	members: Schema.NonEmptyArray(Schema.Int)
})

/** A manifest as cluster.json holds it. */
export type Manifest = typeof Manifest.Type

/** The manifest's file text: its JSON. */
export const ManifestFile = Schema.fromJsonString(Manifest)

/** What `cluster` would record of itself, but for its server and members: what a manifest must agree with. */
export const madeAs = (
	cluster: LocalCluster
): Pick<Manifest, "owner" | "template" | "extensions" | "peerLogins" | "durability"> => ({
	owner: cluster.owner,
	template: cluster.template,
	extensions: cluster.extensions,
	peerLogins: cluster.peerLogins,
	durability: cluster.durability
})

/**
 * Where a manifest differs from what `cluster` states (madeAs), one phrase a difference: a cluster made for another
 * repository's spec on the same port, or for this one's before its spec changed, is refused rather than taken as this.
 */
export const disagreements = (cluster: LocalCluster, manifest: Manifest): ReadonlyArray<string> => {
	const expected = madeAs(cluster)
	const extensionsText = (extensions: Manifest["extensions"]) =>
		Arr.join(
			Arr.map(extensions, ({ name, schema }) => `${name} in ${schema}`),
			", "
		)
	return [
		...(manifest.owner === expected.owner
			? []
			: [`its owner is ${manifest.owner}, not ${expected.owner}`]),
		...(manifest.template === expected.template
			? []
			: [`its template is ${manifest.template}, not ${expected.template}`]),
		...(extensionsText(manifest.extensions) === extensionsText(expected.extensions)
			? []
			: [
					`its template carries [${extensionsText(manifest.extensions)}], not [${extensionsText(expected.extensions)}]`
				]),
		...(Arr.join(manifest.peerLogins, ", ") === Arr.join(expected.peerLogins, ", ")
			? []
			: [
					`its peer logins are [${Arr.join(manifest.peerLogins, ", ")}], not [${Arr.join(expected.peerLogins, ", ")}]`
				]),
		...(manifest.durability === expected.durability
			? []
			: [`it is ${manifest.durability}, not ${expected.durability}`])
	]
}

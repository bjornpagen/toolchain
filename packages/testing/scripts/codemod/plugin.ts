import type { Option } from "effect"
import type * as ts from "typescript/ast"

/** An import a converted module needs: a name from a module, under a local name, as a value or as a type. */
export type Wanted = Readonly<{ module: string; name: string; local: string; type: boolean }>

/**
 * What a layer a test ran under becomes in its property:
 * - `ambient`: services the runner gives every check (the platform's), so the layer goes;
 * - `layer`: a layer of pure services, built for each case around its check;
 * - `need`: a service each case gets from a need, as its own resource (grizzle's Substrate over the case's own database),
 *   which the check provides under `service` to what it runs. `resource` is the name the check reads it under.
 */
export type Provision =
	| Readonly<{ kind: "ambient" }>
	| Readonly<{ kind: "layer"; text: string }>
	| Readonly<{
			kind: "need"
			resource: string
			need: string
			service: string
			imports: ReadonlyArray<Wanted>
	  }>

/**
 * A repository's rewrites: what the codemod must know of a repository beyond the toolchain's own shapes. Everything a
 * plugin does not name is left to a person, with its reason.
 */
export type Plugin = Readonly<{
	/** The repository's test modules, as git pathspecs from its root. */
	include: ReadonlyArray<string>
	/** What a layer, by its text, becomes; none for one a person must convert. */
	provision: (text: string) => Option.Option<Provision>
	/**
	 * Builders of a search's spec, by the module and name they are imported under: a call of one with an object literal
	 * reads as that object literal, its own defaults being runner Limits now.
	 */
	builders: ReadonlyArray<Readonly<{ module: string; name: string }>>
	/**
	 * Functions a stage piped around a search may call that provide what the search runs under (grizzle's
	 * `withLayer(layer)`), as Effect.provide does: the check keeps them around its case.
	 */
	stages: ReadonlyArray<string>
	/**
	 * A test body that wraps its search in checks of the search's result (a counted space, a report on the test), which
	 * the runner now owns: the wrapped `searched(...)` call, or none for a body this plugin does not unwrap.
	 */
	unwrap: (body: ts.Expression) => Option.Option<ts.Expression>
}>

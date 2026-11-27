/**
 * Per-case resources, isolated by construction: no case ever shares a mutable database or directory with another. What
 * is shared is immutable (a Template, built once per cluster member and never changed after); what a case gets is its
 * own (a clone, a scratch directory).
 */
export { type Collected, collect, templatesOf } from "#resources/collect.ts"
export {
	DatabasePrefix,
	type DatabaseName,
	databaseDropped,
	PgCluster,
	type PgClusterSpec,
	type PgMember,
	type PgSession,
	type SessionsAtDrop,
	type Statements
} from "#resources/cluster.ts"
export {
	Database,
	type DatabaseNeed,
	rowsEmptied,
	type TemplateDatabase
} from "#resources/database.ts"
export { templateKeyOf } from "#resources/names.ts"
export { cachedScratch, Scratch, type ScratchDir } from "#resources/scratch.ts"
export {
	type Content,
	DatabaseTemplate,
	type Opened,
	type Origin,
	Template
} from "#resources/template.ts"

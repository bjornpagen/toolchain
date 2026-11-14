import type { CoreOptions, DrizzleOptions, GrizzleOptions } from "#lint/options.ts"
import { noBareMaterializedViewJoins } from "#lint/rules/no-bare-materialized-view-joins.ts"
import { noCaseList } from "#lint/rules/no-case-list.ts"
import { noDrizzleWriteWithoutWhere } from "#lint/rules/no-drizzle-write-without-where.ts"
import { noEnvironment } from "#lint/rules/no-environment.ts"
import { noImplicitSelectAll } from "#lint/rules/no-implicit-select-all.ts"
import { noModuleState } from "#lint/rules/no-module-state.ts"
import { noSpreadArgument } from "#lint/rules/no-spread-argument.ts"
import { noNullUndefinedUnion } from "#lint/rules/null-undefined-union.ts"
import { sqlAliasedTableReference } from "#lint/rules/sql-aliased-table-reference.ts"
import { sqlArrayParameter } from "#lint/rules/sql-array-parameter.ts"
import { sqlCaseArmCast } from "#lint/rules/sql-case-arm-cast.ts"
import { sqlCastOwner } from "#lint/rules/sql-cast-owner.ts"
import { sqlDistinctWindow } from "#lint/rules/sql-distinct-window.ts"
import { sqlDynamicSchema } from "#lint/rules/sql-dynamic-schema.ts"
import { sqlExecutorContract } from "#lint/rules/sql-executor-contract.ts"
import { sqlJsonOwner } from "#lint/rules/sql-json-owner.ts"
import { sqlLeafOwnersOnly } from "#lint/rules/sql-leaf-owners-only.ts"
import { sqlNumberDecoder } from "#lint/rules/sql-number-decoder.ts"
import { sqlQueryDeadline } from "#lint/rules/sql-query-deadline.ts"
import { sqlRawExecution } from "#lint/rules/sql-raw-execution.ts"
import { sqlRawStatement } from "#lint/rules/sql-raw-statement.ts"
import { testCaseIsSearch } from "#lint/rules/test-case-is-search.ts"
import type { Rule } from "#lint/types.ts"

/**
 * superlint's rules, by pack. Every repository runs the core; a repository runs the drizzle pack when it owns an
 * application database and the grizzle pack when its toolchain names it, each with the repository's names for it. A
 * rule whose options name nothing to guard in a repository is inert there. Every rule visits every owned file, test
 * files included.
 */

/** The rules every repository runs. */
export const CORE_RULES: ReadonlyArray<Rule<CoreOptions>> = [
	{ id: "no-module-state", starting: { reads: "file", visit: noModuleState }, gate: "on" },
	{
		id: "no-null-undefined-union",
		starting: { reads: "file", visit: noNullUndefinedUnion },
		gate: "on"
	},
	{ id: "no-spread-argument", starting: { reads: "file", visit: noSpreadArgument }, gate: "on" }
]

/** The SQL and Drizzle rules of a repository that owns an application database. */
export const DRIZZLE_RULES: ReadonlyArray<Rule<DrizzleOptions>> = [
	{
		id: "no-drizzle-write-without-where",
		starting: { reads: "file", visit: noDrizzleWriteWithoutWhere },
		gate: "on"
	},
	{
		id: "no-implicit-select-all",
		starting: { reads: "file", visit: noImplicitSelectAll },
		gate: "on"
	},
	{
		id: "no-bare-materialized-view-joins",
		starting: { reads: "file", visit: noBareMaterializedViewJoins },
		gate: "on"
	},
	{
		id: "sql-aliased-table-reference",
		starting: { reads: "file", visit: sqlAliasedTableReference },
		gate: "on"
	},
	{ id: "sql-array-parameter", starting: { reads: "file", visit: sqlArrayParameter }, gate: "on" },
	{ id: "sql-case-arm-cast", starting: { reads: "file", visit: sqlCaseArmCast }, gate: "on" },
	{ id: "sql-cast-owner", starting: { reads: "file", visit: sqlCastOwner }, gate: "on" },
	{ id: "sql-distinct-window", starting: { reads: "file", visit: sqlDistinctWindow }, gate: "on" },
	{ id: "sql-dynamic-schema", starting: { reads: "file", visit: sqlDynamicSchema }, gate: "on" },
	{
		id: "sql-executor-contract",
		starting: { reads: "file", visit: sqlExecutorContract },
		gate: "on"
	},
	{ id: "sql-json-owner", starting: { reads: "file", visit: sqlJsonOwner }, gate: "on" },
	{ id: "sql-leaf-owners-only", starting: { reads: "file", visit: sqlLeafOwnersOnly }, gate: "on" },
	{ id: "sql-number-decoder", starting: { reads: "file", visit: sqlNumberDecoder }, gate: "on" },
	{ id: "sql-query-deadline", starting: { reads: "file", visit: sqlQueryDeadline }, gate: "on" },
	{ id: "sql-raw-execution", starting: { reads: "file", visit: sqlRawExecution }, gate: "on" },
	{ id: "sql-raw-statement", starting: { reads: "file", visit: sqlRawStatement }, gate: "on" }
]

/** grizzle's rules: tests that are searches, and the rest of its standard. */
export const GRIZZLE_RULES: ReadonlyArray<Rule<GrizzleOptions>> = [
	{ id: "no-case-list", starting: { reads: "program", start: noCaseList }, gate: "on" },
	{ id: "no-environment", starting: { reads: "file", visit: noEnvironment }, gate: "on" },
	{
		id: "test-case-is-search",
		starting: { reads: "program", start: testCaseIsSearch },
		gate: "on"
	}
]

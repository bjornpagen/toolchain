import type { Rule } from "#oxlint/rule.ts"
import { bearerOwners } from "#oxlint/rules/bearer-owners.ts"
import { brandsSoleMint } from "#oxlint/rules/brands-sole-mint.ts"
import { effectFreeImports } from "#oxlint/rules/effect-free-imports.ts"
import { importDoors } from "#oxlint/rules/import-doors.ts"
import { markup } from "#oxlint/rules/markup.ts"
import { noBareMaterializedViewJoins } from "#oxlint/rules/no-bare-materialized-view-joins.ts"
import { noCaseList } from "#oxlint/rules/no-case-list.ts"
import { noCollation } from "#oxlint/rules/no-collation.ts"
import { noComment } from "#oxlint/rules/no-comment.ts"
import { noDefaultParameter } from "#oxlint/rules/no-default-parameter.ts"
import { noDrizzleWriteWithoutWhere } from "#oxlint/rules/no-drizzle-write-without-where.ts"
import { noDynamicImports } from "#oxlint/rules/no-dynamic-imports.ts"
import { noImplicitSelectAll } from "#oxlint/rules/no-implicit-select-all.ts"
import { noInlineSuppression } from "#oxlint/rules/no-inline-suppression.ts"
import { noModuleState } from "#oxlint/rules/no-module-state.ts"
import { noNewError } from "#oxlint/rules/no-new-error.ts"
import { noNullUndefinedUnion } from "#oxlint/rules/no-null-undefined-union.ts"
import { noOptionBridge } from "#oxlint/rules/no-option-bridge.ts"
import { noOptionalParameter } from "#oxlint/rules/no-optional-parameter.ts"
import { noOverload } from "#oxlint/rules/no-overload.ts"
import { noPlant } from "#oxlint/rules/no-plant.ts"
import { noPointlessTypeAlias } from "#oxlint/rules/no-pointless-type-alias.ts"
import { noRawRegexp } from "#oxlint/rules/no-raw-regexp.ts"
import { noRawSql } from "#oxlint/rules/no-raw-sql.ts"
import { noSendBeacon } from "#oxlint/rules/no-send-beacon.ts"
import { noSpreadArgument } from "#oxlint/rules/no-spread-argument.ts"
import { noSvgPaint } from "#oxlint/rules/no-svg-paint.ts"
import { noSvgWithoutTitle } from "#oxlint/rules/no-svg-without-title.ts"
import { noSwitchDefaultBailout } from "#oxlint/rules/no-switch-default-bailout.ts"
import { noTry } from "#oxlint/rules/no-try.ts"
import { noUnoptimizedNextImage } from "#oxlint/rules/no-unoptimized-next-image.ts"
import { noUselessContinue } from "#oxlint/rules/no-useless-continue.ts"
import { preferEarlyReturn } from "#oxlint/rules/prefer-early-return.ts"
import { sideEffectFree } from "#oxlint/rules/side-effect-free.ts"
import { singlePermitOwners } from "#oxlint/rules/single-permit-owners.ts"
import { sqlAliasedTableReference } from "#oxlint/rules/sql-aliased-table-reference.ts"
import { sqlDistinctWindow } from "#oxlint/rules/sql-distinct-window.ts"
import { sqlDynamicSchema } from "#oxlint/rules/sql-dynamic-schema.ts"
import { sqlExecutorContract } from "#oxlint/rules/sql-executor-contract.ts"
import { sqlJsonOwner } from "#oxlint/rules/sql-json-owner.ts"
import { sqlLeafOwnersOnly } from "#oxlint/rules/sql-leaf-owners-only.ts"
import { sqlNumberDecoder } from "#oxlint/rules/sql-number-decoder.ts"
import { sqlQueryDeadline } from "#oxlint/rules/sql-query-deadline.ts"
import { sqlRawExecution } from "#oxlint/rules/sql-raw-execution.ts"
import { sqlRawStatement } from "#oxlint/rules/sql-raw-statement.ts"
import { testNoProseSearch } from "#oxlint/rules/test-no-prose-search.ts"
import { testNoSpelledNames } from "#oxlint/rules/test-no-spelled-names.ts"

/** Every rule of the plugin, by its name. */
const PLUGIN_RULES = {
	"bearer-owners": bearerOwners,
	"brands-sole-mint": brandsSoleMint,
	"effect-free-imports": effectFreeImports,
	"import-doors": importDoors,
	markup,
	"no-bare-materialized-view-joins": noBareMaterializedViewJoins,
	"no-case-list": noCaseList,
	"no-collation": noCollation,
	"no-comment": noComment,
	"no-default-parameter": noDefaultParameter,
	"no-drizzle-write-without-where": noDrizzleWriteWithoutWhere,
	"no-dynamic-imports": noDynamicImports,
	"no-implicit-select-all": noImplicitSelectAll,
	"no-inline-suppression": noInlineSuppression,
	"no-module-state": noModuleState,
	"no-new-error": noNewError,
	"no-null-undefined-union": noNullUndefinedUnion,
	"no-option-bridge": noOptionBridge,
	"no-optional-parameter": noOptionalParameter,
	"no-overload": noOverload,
	"no-plant": noPlant,
	"no-pointless-type-alias": noPointlessTypeAlias,
	"no-raw-regexp": noRawRegexp,
	"no-raw-sql": noRawSql,
	"no-send-beacon": noSendBeacon,
	"no-spread-argument": noSpreadArgument,
	"no-svg-paint": noSvgPaint,
	"no-svg-without-title": noSvgWithoutTitle,
	"no-switch-default-bailout": noSwitchDefaultBailout,
	"no-try": noTry,
	"no-unoptimized-next-image": noUnoptimizedNextImage,
	"no-useless-continue": noUselessContinue,
	"prefer-early-return": preferEarlyReturn,
	"side-effect-free": sideEffectFree,
	"single-permit-owners": singlePermitOwners,
	"sql-aliased-table-reference": sqlAliasedTableReference,
	"sql-distinct-window": sqlDistinctWindow,
	"sql-dynamic-schema": sqlDynamicSchema,
	"sql-executor-contract": sqlExecutorContract,
	"sql-json-owner": sqlJsonOwner,
	"sql-leaf-owners-only": sqlLeafOwnersOnly,
	"sql-number-decoder": sqlNumberDecoder,
	"sql-query-deadline": sqlQueryDeadline,
	"sql-raw-execution": sqlRawExecution,
	"sql-raw-statement": sqlRawStatement,
	"test-no-prose-search": testNoProseSearch,
	"test-no-spelled-names": testNoSpelledNames
} as const satisfies Readonly<Record<string, Rule>>

/**
 * The shared oxlint plugin: the rules oxlint has no built-in rule for. Each reads one file's syntax and scopes alone,
 * as an oxlint JavaScript plugin gets no types, so none builds a TypeScript program; a type-aware check is oxlint's
 * built-in type-aware rules' or an Effect diagnostic. The preset (src/preset.ts) loads it through `jsPlugins`, enables
 * the rules of the packs a repository runs and passes the repository's names as rule options; Node strips its types.
 */
const plugin: Readonly<{ meta: Readonly<{ name: "devtools" }>; rules: typeof PLUGIN_RULES }> = {
	meta: { name: "devtools" },
	rules: PLUGIN_RULES
}

export default plugin

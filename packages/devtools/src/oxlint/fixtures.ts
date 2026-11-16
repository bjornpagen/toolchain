#!/usr/bin/env -S node

import plugin from "#oxlint-plugin.ts"
import { NO_COMMENT_CASES } from "#oxlint/fixer-cases.ts"
import { FIXTURE_RULES } from "#oxlint/fixture-rules.ts"
import { LIMITS_SOLE_MINT_CASES, NO_BARE_LIMIT_CASES } from "#oxlint/limit-cases.ts"
import { runPluginFixtures } from "#oxlint/prove.ts"
import { limitsSoleMint } from "#oxlint/rules/limits-sole-mint.ts"
import { noBareLimit } from "#oxlint/rules/no-bare-limit.ts"
import { noComment } from "#oxlint/rules/no-comment.ts"

runPluginFixtures({
	plugin,
	config: `${import.meta.dirname}/fixtures.config.ts`,
	fixtures: `${import.meta.dirname}/fixtures`,
	rules: FIXTURE_RULES,
	tester: [
		{ name: "no-comment", rule: noComment, cases: NO_COMMENT_CASES },
		{ name: "no-bare-limit", rule: noBareLimit, cases: NO_BARE_LIMIT_CASES },
		{ name: "limits-sole-mint", rule: limitsSoleMint, cases: LIMITS_SOLE_MINT_CASES }
	]
})

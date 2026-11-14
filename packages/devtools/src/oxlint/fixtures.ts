#!/usr/bin/env -S node

import plugin from "#oxlint-plugin.ts"
import { NO_COMMENT_CASES } from "#oxlint/fixer-cases.ts"
import { FIXTURE_RULES } from "#oxlint/fixture-rules.ts"
import { runPluginFixtures } from "#oxlint/prove.ts"
import { noComment } from "#oxlint/rules/no-comment.ts"

runPluginFixtures({
	plugin,
	config: `${import.meta.dirname}/fixtures.config.ts`,
	fixtures: `${import.meta.dirname}/fixtures`,
	rules: FIXTURE_RULES,
	tester: [{ name: "no-comment", rule: noComment, cases: NO_COMMENT_CASES }]
})

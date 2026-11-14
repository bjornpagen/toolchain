import plugin from "#oxlint-plugin.ts"
import { FIXTURE_RULES } from "#oxlint/fixture-rules.ts"
import { fixturesConfig } from "#oxlint/prove.ts"

/** The oxlint configuration the shared plugin's fixtures run under; src/oxlint/fixtures.ts runs oxlint with it. */
export default fixturesConfig({
	plugin,
	specifier: `${import.meta.dirname}/../oxlint-plugin.ts`,
	fixtures: "fixtures",
	rules: FIXTURE_RULES
})

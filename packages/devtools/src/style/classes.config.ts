import { fixturesConfig } from "#oxlint/prove.ts"
import { CLASS_FIXTURE_RULES } from "#style/class-fixtures.ts"
import { TAILWIND_PLUGIN, TAILWIND_PLUGIN_PATH } from "#style/classes.ts"

/** The oxlint configuration the class rules' fixtures run under; the style linter's --fixtures runs oxlint with it. */
export default fixturesConfig({
	plugin: { meta: { name: TAILWIND_PLUGIN }, rules: {} },
	specifier: TAILWIND_PLUGIN_PATH,
	fixtures: "fixtures/classes",
	rules: CLASS_FIXTURE_RULES
})

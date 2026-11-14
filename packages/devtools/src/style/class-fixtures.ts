import { Array as Arr, Option, Record } from "effect"
import { type ClassSource, classSettingsOf } from "#style/classes.ts"

/** The class rules' fixtures: a directory per plugin rule, holding its violating and clean fixture (no-restricted-classes
 * holds the palette's beneath it), read against the design system support/theme.css defines. */
export const CLASS_FIXTURES = `${import.meta.dirname}/fixtures/classes`

/** The oxlint configuration the class rules' fixtures run under, by its absolute path. */
export const CLASS_FIXTURES_CONFIG = `${import.meta.dirname}/classes.config.ts`

const SOURCE: ClassSource = {
	cwd: CLASS_FIXTURES,
	entryPoint: `${CLASS_FIXTURES}/support/theme.css`
}

/** Every plugin rule the class rules run, with the options an app's block gives it, on the fixtures' design system. */
export const CLASS_FIXTURE_RULES: Readonly<Record<string, unknown>> = Record.fromEntries(
	Arr.map(classSettingsOf(SOURCE, []), (setting) => [
		setting.rule,
		Option.getOrNull(setting.options)
	])
)

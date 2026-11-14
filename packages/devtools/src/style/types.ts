import { Array as Arr } from "effect"
import { CLASS_RULE_IDS } from "#style/classes.ts"

/** The style linter's own rules, by the id each reports under: the stylesheet contract, and standalone HTML, which
 * oxlint does not read, under markup. */
const SHEET_RULES = ["stylesheet", "markup"] as const

/** The style rules oxlint runs on a Tailwind app's files through the preset, with the app's options from the web pack:
 * the plugin's markup and no-svg-paint, and the class rules eslint-plugin-better-tailwindcss holds. A web pack's
 * exception that names one turns it off on its files. */
const OXLINT_RULES: ReadonlyArray<string> = ["markup", "no-svg-paint", ...CLASS_RULE_IDS]

/** Every shared style rule an exception may name. A repository's own style rules report under ids of their own, which
 * none of these may be. */
export const STYLE_RULES: ReadonlyArray<string> = Arr.dedupe([...SHEET_RULES, ...OXLINT_RULES])

export type SheetRule = (typeof SHEET_RULES)[number]

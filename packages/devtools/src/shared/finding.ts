import { Array as Arr, Order } from "effect"
import { relativeTo } from "#shared/repository.ts"

/** One report of a dev tool (the workspace gate, the style linter, a repository's own style rules): the rule that
 * fired, where, what is wrong, and how to fix it when the rule knows. Lines and columns are 1-based, as an editor shows
 * them. */
export type Finding = Readonly<{
	file: string
	line: number
	column: number
	rule: string
	message: string
	suggestion?: string
}>

const byLocation = Order.combineAll<Finding>([
	Order.mapInput(Order.String, (finding: Finding) => finding.file),
	Order.mapInput(Order.Number, (finding: Finding) => finding.line),
	Order.mapInput(Order.Number, (finding: Finding) => finding.column),
	Order.mapInput(Order.String, (finding: Finding) => finding.rule)
])

/** The findings in file and line order, one per line with its suggestion beneath, and the tool's tally; files show
 * relative to the repository root. */
export const renderFindings = (
	input: Readonly<{ tool: string; root: string; findings: ReadonlyArray<Finding> }>
): string => {
	const { tool, findings } = input
	const shown = relativeTo(input.root)
	if (!Arr.isReadonlyArrayNonEmpty(findings)) {
		return `${tool}: no findings`
	}
	const lines = Arr.flatMap(Arr.sort(findings, byLocation), (finding) => {
		const located = `${shown(finding.file)}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}`
		return finding.suggestion === undefined ? [located] : [located, `  ↳ ${finding.suggestion}`]
	})
	return Arr.join([...lines, `${tool}: ${findings.length} finding(s)`], "\n")
}

/** A linter's exit status: 1 when it found anything. */
export const statusOf = (findings: ReadonlyArray<unknown>): number =>
	Arr.isReadonlyArrayNonEmpty(findings) ? 1 : 0

import { Array as Arr, Duration, Option } from "effect"
import type { Oracle } from "#explore.ts"
import { RISK_BOUND_MISS, type Residual } from "#features.ts"
import type { Finding, Measures, Printed, Shrinking, Verdict } from "#runner/protocol.ts"

/**
 * What a run prints: one line per property, its residual risk or its proof, and for each failure exactly the case it
 * ran, the failure and its replay token. Nothing else.
 */

/** How many decimals a risk prints with. */
const RISK_DIGITS = 4

/** How many decimals Chao1's estimate of the unseen situations prints with. */
const UNSEEN_DIGITS = 1

/** A property's oracle as its report line prints it, and its absence named, so a property that states none shows. */
const oracleText = (oracle: Oracle): string => {
	switch (oracle.kind) {
		case "unstated":
			return "oracle not stated"
		case "second-implementation":
		case "specification":
		case "universal":
		case "postgresql":
			return `oracle: ${oracle.kind}, ${oracle.name}`
	}
}

/** The run of cases a residual's bound rests on, as its line prints it. */
const runText = (sinceNew: number): string =>
	sinceNew === 0
		? "its last case reached a new situation"
		: sinceNew === 1
			? "none new in its last case"
			: `none new in its last ${sinceNew} cases`

/**
 * A residual's risk as its line prints it: unknown, and why, or Good–Turing's estimate beside its bound, the confidence
 * the bound holds at, and the run of cases it rests on.
 */
const riskText = (residual: Residual): string => {
	switch (residual.risk.kind) {
		case "unknown":
			return residual.risk.why === "no-cases"
				? "risk unknown: no independent case ran"
				: "risk unknown: no case noted a situation"
		case "estimated":
			return `risk ${residual.risk.estimate.toFixed(RISK_DIGITS)}, at most ${residual.risk.bound.toFixed(RISK_DIGITS)} at ${Math.round((1 - RISK_BOUND_MISS) * 100)}% (${runText(residual.sinceNew)}), unseen ${Option.match(residual.unseen, { onNone: () => "unknown", onSome: (unseen) => `about ${unseen.toFixed(UNSEEN_DIGITS)}` })}`
	}
}

/** What a property's cases measured, after a semicolon, each name with its sum. */
const measuresText = (measures: Measures): string =>
	Arr.isReadonlyArrayNonEmpty(measures)
		? `; ${Arr.join(
				Arr.map(measures, ([name, sum]) => `${name} ${sum}`),
				", "
			)}`
		: ""

/** A case as a report prints it: its value, then what its property drew, when it drew anything. */
const printedText = (printed: Printed): ReadonlyArray<string> => {
	switch (printed.kind) {
		case "undrawn":
			return [`case: none, ${printed.why}`]
		case "drawn":
			return [
				`case: ${printed.value}`,
				...(Arr.isReadonlyArrayNonEmpty(printed.draws)
					? [`the property drew: ${Arr.join(printed.draws, ", ")}`]
					: [])
			]
	}
}

/** How far a failing case was shrunk, as its report prints it. */
const shrinkingText = (shrinking: Shrinking): string => {
	switch (shrinking.kind) {
		case "minimal":
			return `shrunk in ${shrinking.candidates} candidates`
		case "budget":
			return `shrunk in ${shrinking.candidates} candidates, cut short by its budget`
		case "unshrunk":
			return "not shrunk"
	}
}

/** The command that replays a token. */
const replayText = (token: string): string => `replay: toolchain-test replay '${token}'`

/** A finding's headline: what failed, and where. */
const headlineOf = (finding: Finding): string => {
	switch (finding.kind) {
		case "falsified":
			return `falsified on ${finding.where}`
		case "hung":
			return `hung on ${finding.where}`
		case "misused":
			return `used its case after the case ended, on ${finding.where}`
		case "lost":
			return `lost its worker on ${finding.where}`
		case "stale":
			return `${finding.where} is stale`
		case "unreached":
			return `no witness reached ${Arr.join(finding.missing, ", ")}`
		case "uncountable":
			return `its space could not be counted within the case deadline of ${Duration.format(Duration.millis(finding.deadline))}`
	}
}

/** A finding's lines below its headline: the case as it ran, the failure, the shrink and the replay token. */
const findingLines = (finding: Finding): ReadonlyArray<string> => {
	switch (finding.kind) {
		case "falsified":
			return [
				...printedText(finding.printed),
				finding.failure,
				shrinkingText(finding.shrinking),
				replayText(finding.token)
			]
		case "hung":
			return [...printedText(finding.printed), replayText(finding.token)]
		case "misused":
			return printedText(finding.printed)
		case "lost":
			return [finding.report]
		case "stale":
			return [finding.why]
		case "unreached":
			return [
				finding.witnessed.kind === "streams"
					? `its witnesses, ${finding.witnessed.floor} floor cases and ${finding.witnessed.steered} steered cases, are fixed by its identity, so every run seed fails alike: give its space an arm that reaches them, aim its space at what is pending, or guide it`
					: `none of its space's ${finding.witnessed.cases} cases reached them`
			]
		case "uncountable":
			return [
				`a space too large to count is too large to exhaust (${finding.box}): exhaust a smaller one, or explore it`
			]
	}
}

/** The one line a property's verdict prints: its residual or its proof, its oracle, or that it failed. */
export const lineOf = (id: string, oracle: Oracle, verdict: Verdict): string => {
	switch (verdict.kind) {
		case "explored":
			return `${id}: ${verdict.residual.cases} independent cases, ${verdict.residual.observed} situations, ${verdict.residual.singletons} seen once, ${riskText(verdict.residual)}, ${verdict.steered} steered${measuresText(verdict.measures)}; ${oracleText(oracle)}`
		case "exhausted":
			return `${id}: a proof inside ${verdict.box}, ${verdict.cases} cases${measuresText(verdict.measures)}; ${oracleText(oracle)}`
		case "replayed":
			return `${id}: the replayed case passed`
		case "failed":
			return `${id}: FAILED, ${headlineOf(verdict.finding)}`
	}
}

/** The lines a failing verdict prints under its line: the case as it ran, the failure and its token. */
export const failureLines = (verdict: Verdict): ReadonlyArray<string> => {
	switch (verdict.kind) {
		case "explored":
		case "exhausted":
			return []
		case "replayed":
			return printedText(verdict.printed)
		case "failed":
			return Arr.map(findingLines(verdict.finding), (line) => `  ${line}`)
	}
}

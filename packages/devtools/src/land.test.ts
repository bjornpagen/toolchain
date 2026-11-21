/**
 * toolchain-land (bin/land.sh): lanes land on their repository's hub with no lock and no waiting, the jj-lanes flow:
 * each fetches the hub, rebases its workspace's finished commits onto the hub's trunk, formats them (jj fix), runs the
 * thin gate on what lands and pushes it as a fast-forward; a landing whose push is refused because the trunk moved
 * lands again from the fetch, on top of what moved it; a landing whose commit conflicts with the trunk is refused before
 * its gate and pushes nothing. The whole gate is trunk@<repo>'s, never a landing's.
 *
 * Each case draws a scenario (lanes landing at once, a lane whose commit conflicts with one landed before it, a lane
 * whose trunk moves while its gate is held, or a lane whose hub's trunk is staging, behind main as edullm's is, or that
 * states no trunk), builds it from a bare hub and jj workspaces colocated with git clones of it
 * (the remote `hub`) in a scratch directory of its own, HOME pointing there and jj configured for the case alone, and
 * lands from its lanes; the thin gate's typecheck is the probe, and each lane's formatter a stand-in that strips the
 * spaces ending a line, run as the account's fixer (the workbench's jj part). Oracle: the specification, land.sh's header: landings at once each land, the trunk gaining one
 * commit a landing with no merge and every lane's change as its formatter writes it; every commit the trunk gained had
 * its tree gated; the second of two conflicting landings is refused, naming the conflict, and its gate never ran; and a
 * landing whose trunk moved under its gate says it lands again and lands, its first and second commits each gated; a
 * landing pushes the trunk its hub states and no other, main untouched where the trunk is staging, and a hub that
 * states none refuses it before its gate.
 */
import { assert, containsText, defined } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect } from "effect"
import {
	AGAIN,
	CONFLICT,
	conflicting,
	fixedText,
	gatedEvery,
	landedAll,
	landedAt,
	landingFeatures,
	landings,
	NO_TRUNK,
	sandboxOf,
	trunkOf,
	workspaceLockfile
} from "#land.fixtures.ts"

export const landsFastForward = property.exhaust(finite(landings), {
	box: "one, two or three lanes landing at once with files of their own, a lane whose commit conflicts with one landed before it, a lane whose trunk moves while it is gated, and a lane whose hub's trunk is staging or states none",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a lane lands alone",
		"two lanes land at once",
		"three lanes land at once",
		"a landing whose commit conflicts is refused",
		"a landing whose push is refused lands again",
		"a landing pushes the hub's trunk when it is not main, and main stays",
		"a hub that states no trunk refuses the landing"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(landing) =>
			Effect.gen(function* () {
				c.noteAll(landingFeatures(landing))
				const scratch = yield* dir
				const landCheckout = yield* checkout
				const workspace = yield* lockfile
				const sandbox = sandboxOf(scratch, landCheckout, workspace)
				const done = yield* landedAll(sandbox, landing)
				const said = `the landings said: ${Arr.join(
					Arr.map(done.lands, (one) => one.stderr),
					"\n"
				)}`
				const landed = landedAt(done.lands)
				if (conflicting(landing)) {
					assert.deepEqual(landed, [0], said)
					containsText(defined(done.lands[1], "the second landing").stderr, CONFLICT)
					assert.deepEqual(done.gated, done.gained, said)
					assert.deepEqual(done.texts, [fixedText(0), fixedText(0)], said)
				} else if (trunkOf(landing) === "none") {
					assert.deepEqual(landed, [], said)
					containsText(defined(done.lands[0], "the landing").stderr, NO_TRUNK)
					assert.deepEqual(done.gated, [], said)
				} else {
					assert.deepEqual(landed.length, done.lands.length, said)
					assert.deepEqual(
						done.texts,
						Arr.map(done.texts, (_, at) => fixedText(at)),
						said
					)
				}
				assert.deepEqual(
					done.mainGained,
					trunkOf(landing) === "main" ? landed.length : 0,
					`main gained ${String(done.mainGained)} commits: ${said}`
				)
				assert.deepEqual(done.gained.length, landed.length, said)
				assert.deepEqual(done.merges, [])
				assert.ok(
					gatedEvery(done.gained, done.gated),
					`a commit the trunk gained was never gated: ${said}`
				)
				if (landing === "a lane whose trunk moves while it is gated") {
					containsText(defined(done.lands[0], "the held landing").stderr, AGAIN)
					assert.deepEqual(done.gated.length, 3, said)
				}
			}),
	oracle: {
		kind: "specification",
		name: "landings land on the hub with no lock as fast-forwards of the trunk the hub states (main, or staging, main then untouched), each formatted and gated on what lands and landed again from the fetch when the trunk moved under it, the trunk linear; a landing whose commit conflicts, or whose hub states no trunk, is refused before its gate and pushes nothing"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/land.sh",
			original: '\tjj rebase -b @ -o "$branch@hub"\n',
			replacement: "\t:\n",
			why: "A landing pushes its workspace's commits where they are, so a landing after another's is a sideways move of the trunk, which jj's bookmark refuses, and it never lands; the lands-fast-forward property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: "while :; do",
			replacement: "for _ in once; do",
			why: "A landing whose push is refused because the trunk moved gives up after its first try and exits as if it had landed, its change never on the trunk; the lands-fast-forward property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: "\tpnpm types\n",
			replacement: "\ttrue\n",
			why: "A landing runs no typecheck, so the hub's trunk gains commits the thin gate never judged (jj runs no git hook to stand in for it); the lands-fast-forward property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: '\t[ -z "$conflicted" ] ||\n',
			replacement: "\ttrue ||\n",
			why: "A landing whose commit conflicts goes on to gate the conflicted commit, which jj then refuses to push, so its gate ran for a commit that can never land; the lands-fast-forward property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: 'branch=$(git --git-dir="$hub" config --get trunk.branch) ||',
			replacement: "branch=main ||",
			why: "A landing pushes main whatever trunk its hub states, so a lane of a repository whose trunk is staging moves main, edullm's production, and leaves staging behind; the lands-fast-forward property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: 'branch=$(git --git-dir="$hub" config --get trunk.branch) ||',
			replacement: 'branch=$(git --git-dir="$hub" config --get trunk.branch || echo main) ||',
			why: "A hub that states no trunk falls on main by default, so a landing where the workbench wrote no trunk pushes main; the lands-fast-forward property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: '\tjj fix -s "$branch@hub..@"\n',
			replacement: "\ttrue\n",
			why: "A landing formats nothing, so its commits land as the lane wrote them, the spaces its formatter strips still ending their lines; the lands-fast-forward property fails."
		}
	]
})

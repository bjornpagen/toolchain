/**
 * toolchain-land (bin/land.sh): clones landing at once land one at a time, each rebased onto the trunk inside the push
 * lock and gated once, on the commit that lands, the trunk's history linear; a landing whose commits conflict aborts its
 * rebase and pushes nothing; and the trunk is taken from landings alone, by the push gate, by a repository's own
 * pre-push script and by a local hub, while every other branch passes.
 *
 * Each case draws a scenario (how many clones land at once and whether their commits conflict, and the origin they push
 * to; or what checks a push, how it is made and what it updates), builds it from real git repositories in a scratch
 * directory of its own, HOME pointing there so the binding's lock is the case's own, and lands or pushes from its
 * clones. Oracle: the specification, land.sh's header: landings at once each land, their stand-in gates' runs never
 * overlap and are one per landing, each given a commit the trunk gained, and the trunk holds every landing's change
 * with no merge; the second of two conflicting landings is refused, its clone left clean at its own commit; and a push
 * updates the trunk only when it is a landing's, holding the lock, which a holder it does not descend from or a holder
 * holding no lock cannot stand in for.
 */
import { assert, containsText, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Option } from "effect"
import { sandboxOf, workspaceLockfile } from "#gate.fixtures.ts"
import {
	branchOf,
	changed,
	changeOf,
	clonesIn,
	cloneOf,
	conflicting,
	gateRuns,
	hubCommits,
	hubHolds,
	hubMerges,
	hubOf,
	inTurn,
	landed,
	landingFeatures,
	landingsGen,
	pushedThrough,
	pushingFeatures,
	pushings,
	readyToPush,
	refusalOf,
	standing,
	taken
} from "#land.fixtures.ts"

export const landsInTurn = property.exhaust(finite(landingsGen), {
	box: "one, two or three clones landing at once, with commits of their own files or two changing the same line, on a local hub or a remote",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a clone lands alone",
		"two clones land at once",
		"three clones land at once",
		"the second of two landings conflicts",
		"a landing on a local hub",
		"a landing on a remote"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(landings) =>
			Effect.gen(function* () {
				c.noteAll(landingFeatures(landings))
				const scratch = yield* dir
				const gateCheckout = yield* checkout
				const workspace = yield* lockfile
				const sandbox = sandboxOf(scratch, gateCheckout, workspace)
				const hub = yield* hubOf(sandbox, landings.origin)
				const before = yield* hubCommits(sandbox, hub.directory, "main")
				const clones = yield* Effect.forEach(
					Array.from({ length: clonesIn(landings.landing) }, (_, at) => at),
					(at) =>
						Effect.gen(function* () {
							const clone = yield* cloneOf(sandbox, hub.url, `c${String(at)}`, "a stand-in gate")
							const [file, text] = changeOf(landings.landing, at)
							const commit = yield* changed(sandbox, clone, file, text)
							return { clone, file, commit }
						})
				)
				const lands = yield* Effect.forEach(clones, ({ clone }) => landed(sandbox, clone), {
					concurrency: "unbounded"
				})
				const landedAt = Arr.filter(
					Array.from({ length: clones.length }, (_, at) => at),
					(at) => Arr.getUnsafe(lands, at).status === 0
				)
				if (conflicting(landings.landing)) {
					assert.deepEqual(
						landedAt.length,
						1,
						`the landings said: ${Arr.join(
							Arr.map(lands, (done) => done.stderr),
							"\n"
						)}`
					)
					const refusedAt = defined(
						Arr.findFirst(
							Array.from({ length: clones.length }, (_, at) => at),
							(at) => !Arr.contains(landedAt, at)
						).pipe(Option.getOrUndefined),
						"no landing was refused"
					)
					const refused = Arr.getUnsafe(lands, refusedAt)
					containsText(refused.stderr, "conflict")
					const left = yield* standing(sandbox, Arr.getUnsafe(clones, refusedAt).clone)
					assert.deepEqual(left, {
						head: Arr.getUnsafe(clones, refusedAt).commit,
						clean: true,
						rebasing: false
					})
				} else {
					assert.deepEqual(
						landedAt.length,
						clones.length,
						`the landings said: ${Arr.join(
							Arr.map(lands, (done) => done.stderr),
							"\n"
						)}`
					)
					yield* Effect.forEach(clones, ({ file }) =>
						Effect.map(hubHolds(sandbox, hub.directory, file), (holds) =>
							assert.ok(holds, `the trunk lacks ${file}`)
						)
					)
				}
				const after = yield* hubCommits(sandbox, hub.directory, "main")
				const gained = Arr.take(after, after.length - before.length)
				assert.deepEqual(gained.length, landedAt.length)
				const merges = yield* hubMerges(sandbox, hub.directory)
				assert.deepEqual(merges, [])
				const runs = yield* gateRuns(sandbox)
				assert.ok(inTurn(runs), "two gates ran at once")
				unorderedEqual(
					Arr.map(runs, (run) => run.commit),
					gained
				)
			}),
	oracle: {
		kind: "specification",
		name: "landings at once each land in turn, rebased inside the push lock and gated once on the commit the trunk gains, the trunk linear; the second of two conflicting landings is refused with its clone clean at its own commit"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/land.sh",
			original: 'perl "$(dirname -- "$self")/../../testing/scripts/hold.pl" wait exclusive 1 9',
			replacement: ":",
			why: "Landings take no lock, so clones landing at once gate at once and all but the first push a commit that is no fast-forward of the trunk, refused after its gate (metis's O(N²) gates); the lands-in-turn property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: 'if ! git rebase -q "$trunk"; then',
			replacement: "if false; then",
			why: "A landing pushes its clone's commits as they are, so every landing after the first sends a commit that is no fast-forward of the trunk another landing moved; the lands-in-turn property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: "\t\t\tgit rebase --abort\n",
			replacement: "",
			why: "A conflicting landing leaves its clone mid-rebase, its commit unapplied and the conflict in its working tree; the lands-in-turn property fails."
		}
	]
})

export const trunkFromLandings = property.exhaust(finite(pushings), {
	box: "a push checked by the push gate, a repository's pre-push script or a local hub, made plainly, naming a holder it does not descend from, naming itself or by a landing, to the trunk or another branch",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"the push gate checks a push",
		"a repository's pre-push script checks a push",
		"a local hub checks a push",
		"a plain push",
		"a push naming a holder it does not descend from",
		"a push naming itself, which holds no lock",
		"a landing",
		"a push to the trunk",
		"a push to another branch"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(pushing) =>
			Effect.scoped(
				Effect.gen(function* () {
					c.noteAll(pushingFeatures(pushing))
					const scratch = yield* dir
					const gateCheckout = yield* checkout
					const workspace = yield* lockfile
					const sandbox = sandboxOf(scratch, gateCheckout, workspace)
					const ready = yield* readyToPush(sandbox, pushing.checker)
					const done = yield* pushedThrough(sandbox, ready.clone, pushing)
					const branch = branchOf(pushing)
					const after = yield* hubCommits(sandbox, ready.hub, branch)
					if (taken(pushing)) {
						assert.deepEqual(done.status, 0, `the push was refused: ${done.stderr}`)
						const head = yield* Effect.map(standing(sandbox, ready.clone), (left) => left.head)
						assert.deepEqual(Arr.head(after), Option.some(head))
					} else {
						assert.notEqual(done.status, 0, "the push was taken")
						containsText(done.stderr, refusalOf(pushing.checker))
						assert.deepEqual(after, branch === "main" ? ready.before : [])
					}
				})
			),
	oracle: {
		kind: "specification",
		name: "the trunk moves only by a landing, which holds the push lock and descends from its holder, whether the push gate, a repository's own pre-push script or a local hub checks it, and every other branch passes"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'printf \'%s\' "$sent" | sh "$land" pre-push',
			replacement: ":",
			why: "The push gate runs no landing's check, so a plain push to the trunk from a clone whose hook is the push gate lands unrebased and unlocked; the trunk-from-landings property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: '| updates 3 "refs/heads/$branch" && ! holds',
			replacement: "| false && ! holds",
			why: "The pre-push check refuses nothing, so a push to the trunk passes the push gate and a repository's pre-push script without a landing; the trunk-from-landings property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: '\t\tif updates 3 "refs/heads/$branch" && ! holds',
			replacement: "\t\tif false && ! holds",
			why: "A local hub takes the trunk from any push, so a clone whose hook is older than land moves it with no landing; the trunk-from-landings property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: '\t[ "$process" = "$1" ] || return 1\n',
			replacement: "",
			why: "A push naming as its holder another clone's landing, which holds the lock, passes though it does not descend from it, so it lands while that landing is between its rebase and its push; the trunk-from-landings property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original:
				'grep -Eqs "^lock:.*FLOCK +ADVISORY +WRITE +[0-9-]+ +[0-9a-f]+:[0-9a-f]+:$inode " "/proc/$1/fdinfo/"*',
			replacement: "true",
			why: "A push naming itself as the holder passes though it holds no lock, so any environment lets a push through; the trunk-from-landings property fails."
		},
		{
			file: "packages/devtools/bin/land.sh",
			original: '\t\t\tmv -- "$origin/hooks/pre-receive.$$" "$origin/hooks/pre-receive"\n',
			replacement: "",
			why: "A landing never installs the hub's hook, so a local hub takes the trunk from a clone whose hook is older than land; the trunk-from-landings property fails."
		}
	]
})

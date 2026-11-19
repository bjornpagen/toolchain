/**
 * The gate's snapshot cache (bin/gate.sh): snapshots per repository, shared by every clone of it however it writes its
 * origin, each with the objects of the clone whose commit is checked; a run that claims the first snapshot no live run
 * holds, never waiting; and a snapshot whose repository is gone collected.
 *
 * Each case draws the shape of a scenario (how many clones of one repository and how they write its URL, what each
 * commits and leaves uncommitted, which clone each run checks, whether the repository has a submodule and at which
 * commit, what a run's command leaves behind, which snapshots live or exited runs hold, the key directories beside it
 * and what became of their clones and locks, the phase a run is in when another repository's run collects beside it),
 * builds it from real git repositories in a scratch directory of its own,
 * and runs the gate over its clones with a cache of its own (XDG_CACHE_HOME), so nothing here touches the real cache.
 * Oracle: the specification, the gate's header: a command the gate runs on a commit sees exactly that commit's files, a
 * submodule's at the commit it records; a file a first run left under .gitignore (node_modules) is still there for a
 * second clone's first run, which is what a warm snapshot is; a run beside live runs takes the first snapshot none of
 * them holds, or a new one, and fills it to exactly its commit whatever a killed run left there; and a run collects
 * every other key directory whose repository is gone and that no live run holds, and never one a run of its
 * repository holds in any phase of its life, from before it claims a snapshot to the last process it started.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import {
	alternatesOf,
	befell,
	checkedClones,
	claimedBy,
	claimedSlot,
	claimingFeatures,
	claimings,
	free,
	checkingFeatures,
	checkings,
	clonedRepository,
	clonesListed,
	clonesRunBy,
	collectingFeatures,
	collectings,
	commonDirectory,
	fillingFeatures,
	fillings,
	kept,
	keptThrough,
	keys,
	looked,
	objectsOf,
	newCommit,
	onlyKey,
	pushCallFeatures,
	pushCalls,
	pushedAs,
	pushLock,
	REFUSED_CALL,
	registered,
	sandboxOf,
	sharingFeatures,
	sharings,
	slotted,
	spelledClones,
	stampsBefore,
	sweepFeatures,
	sweeps,
	sweptBeside,
	takesCall,
	submoduleClones,
	treeOf,
	versionFile,
	versionFilesOf,
	workspaceLockfile
} from "#gate.fixtures.ts"

export const sharedSnapshot = property.exhaust(finite(sharings), {
	box: "every way three runs fall among up to three clones of one repository, each leaving a stamp, the later clones writing its URL each way",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a second clone's first run finds what a first run left under .gitignore",
		"a clone runs again after another clone's run",
		"three clones share one snapshot",
		"a clone whose origin URL ends in .git shares the snapshot",
		"a clone whose origin URL ends in / shares the snapshot"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(sharing) =>
			Effect.gen(function* () {
				c.noteAll(sharingFeatures(sharing))
				const scratch = yield* dir
				const gateCheckout = yield* checkout
				const workspace = yield* lockfile
				const sandbox = sandboxOf(scratch, gateCheckout, workspace)
				const { clones } = yield* spelledClones(sandbox, sharing)
				yield* Effect.forEach(sharing.runs, (run, index) =>
					Effect.gen(function* () {
						const clone = Arr.getUnsafe(clones, run.clone)
						const seen = yield* looked(sandbox, clone, index, { stamp: run.stamps, stray: false })
						deepStrictEqual(seen.stamps, stampsBefore(sharing, index))
						const key = yield* onlyKey(sandbox)
						const listed = yield* clonesListed(sandbox, key)
						deepStrictEqual(
							listed,
							Arr.map(clonesRunBy(sharing, index), (at) =>
								commonDirectory(Arr.getUnsafe(clones, at))
							)
						)
					})
				)
			}),
	oracle: {
		kind: "specification",
		name: "the gate's cache layout: one key directory per repository, named by its origin's URL with no trailing .git or / and listing every clone that ran, whose snapshot keeps what .gitignore names between runs"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'identity=$(git --git-dir="$1" config --get remote.origin.url 2>/dev/null || true)',
			replacement: "identity=",
			why: "The key is each clone's own git directory, not its repository's URL, so every clone keeps a snapshot of its own (the old per-path layout) and a second clone's first run is cold; the shared-snapshot property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: `identity=\${identity%.git}`,
			replacement: ":",
			why: "A clone whose origin URL ends in .git keys a cache of its own beside the one its repository's other clones share (grizzle's 5b2a7da5aaff and 3b452b0d8c62), so its first run is cold; the shared-snapshot property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: `identity=\${identity%/}`,
			replacement: ":",
			why: "A clone whose origin URL ends in / keys a cache of its own beside the one its repository's other clones share; the shared-snapshot property fails."
		}
	]
})

export const claimedSnapshot = property.exhaust(finite(claimings), {
	box: "the push mode's first two snapshots, each free, held by a live run or left half-filled by a killed one, when a run comes to check a commit neither holds",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a run claims a snapshot no run holds",
		"a run passes a snapshot a live run holds",
		"a run takes over a snapshot a killed run left half-filled",
		"every snapshot held: a run makes a new one"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(slots) =>
			Effect.scoped(
				Effect.gen(function* () {
					c.noteAll(claimingFeatures(slots))
					const scratch = yield* dir
					const gateCheckout = yield* checkout
					const workspace = yield* lockfile
					const sandbox = sandboxOf(scratch, gateCheckout, workspace)
					const { clones } = yield* clonedRepository(sandbox, 1)
					const clone = Arr.headNonEmpty(clones)
					yield* looked(sandbox, clone, 0, { stamp: false, stray: false })
					const key = yield* onlyKey(sandbox)
					yield* newCommit(sandbox, clone)
					yield* Effect.forEach(
						Arr.reverse(Arr.map(slots, (slot, at) => [slot, at] as const)),
						([slot, at]) => slotted(sandbox, key, slot, at)
					)
					const claimed = claimedSlot(slots)
					const run = yield* claimedBy(sandbox, clone)
					deepStrictEqual(run.snapshot, `push.${String(claimed)}`)
					const tree = yield* treeOf(sandbox, clone)
					deepStrictEqual(run.seen.files, tree)
					const freed = yield* Effect.forEach(slots, (_, at) =>
						free(sandbox, pushLock(sandbox, key, at))
					)
					deepStrictEqual(
						freed,
						Arr.map(slots, (slot) => slot !== "live")
					)
				})
			),
	oracle: {
		kind: "specification",
		name: "a run claims the first snapshot of its mode that no live run holds, a new one when every one is held, never waits, fills it to exactly its commit whatever a killed run left there, and lets go of it when it exits"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'snapshot="$cache/$1.$n"',
			replacement: 'snapshot="$cache/$1.0"',
			why: "Every run checks in the first snapshot whatever holds it, so a run beside a live one rewrites the files that run is checking; the claimed-snapshot property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'until exec 9>>"$cache/$1.$n.lock" && hold try exclusive 1 9; do',
			replacement: 'until exec 9>>"$cache/$1.$n.lock"; do',
			why: "A run takes the first snapshot without its lock, so it checks in one a live run is filling and checking; the claimed-snapshot property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'GIT_DIR=$4 git --work-tree="$3" read-tree --reset -u "$2^{tree}"',
			replacement: 'GIT_DIR=$4 git --work-tree="$3" read-tree -m -u "$2^{tree}"',
			why: "A snapshot is merged into, not reset, so one a killed run left with a file cut short is refused and the run fails, where it must check its commit; the claimed-snapshot property fails."
		}
	]
})

export const checkedCommit = property.exhaust(finite(checkings), {
	box: "two clones of every shape (a commit of its own or none, uncommitted edits or none), checked by three runs in turn",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a commit checked after another clone's different commit",
		"a commit lacking a file the commit checked before held",
		"a working tree with edits it has not committed",
		"a stray file an earlier run left"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(checking) =>
			Effect.gen(function* () {
				c.noteAll(checkingFeatures(checking))
				const scratch = yield* dir
				const gateCheckout = yield* checkout
				const workspace = yield* lockfile
				const sandbox = sandboxOf(scratch, gateCheckout, workspace)
				const { clones } = yield* checkedClones(sandbox, checking.clones)
				yield* Effect.forEach(checking.runs, (run, index) =>
					Effect.gen(function* () {
						const clone = Arr.getUnsafe(clones, run.clone)
						const seen = yield* looked(sandbox, clone, index, { stamp: false, stray: run.strays })
						const tree = yield* treeOf(sandbox, clone)
						deepStrictEqual(seen.files, tree)
						const key = yield* onlyKey(sandbox)
						const borrowed = yield* alternatesOf(sandbox, key)
						deepStrictEqual(borrowed, objectsOf(clone))
					})
				)
			}),
	oracle: {
		kind: "specification",
		name: "a command the gate runs on a commit sees exactly that commit's files, from the objects of the clone that holds it"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'GIT_DIR=$1 git rev-parse --git-path objects >"$4/objects/info/alternates"',
			replacement:
				'[ -s "$4/objects/info/alternates" ] || GIT_DIR=$1 git rev-parse --git-path objects >"$4/objects/info/alternates"',
			why: "The snapshot keeps borrowing the objects of the first clone that ran, so a commit only a later clone holds is not there to check out; the checked-commit property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'GIT_DIR=$4 git --work-tree="$3" clean -fdq',
			replacement: "true",
			why: "A file no index knows, a stray an earlier run's check wrote, stays in the snapshot, so a later run sees a file its commit lacks; the checked-commit property fails."
		}
	]
})

export const filledSubmodule = property.exhaust(finite(fillings), {
	box: "a submodule of two versions recorded at either, and two clones of every committed and checked-out version, run in turn",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a submodule at the commit the repository recorded",
		"a submodule its clone's own commit moved",
		"a submodule recorded behind its repository's tip",
		"a working tree's submodule checked out at another commit",
		"a submodule filled at another commit by the run before"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(filling) =>
			Effect.gen(function* () {
				c.noteAll(fillingFeatures(filling))
				const scratch = yield* dir
				const gateCheckout = yield* checkout
				const workspace = yield* lockfile
				const sandbox = sandboxOf(scratch, gateCheckout, workspace)
				const { clones } = yield* submoduleClones(sandbox, filling)
				yield* Effect.forEach(filling.runs, (at, index) =>
					Effect.gen(function* () {
						const clone = Arr.getUnsafe(clones, at)
						const seen = yield* looked(sandbox, clone, index, { stamp: false, stray: false })
						deepStrictEqual(versionFilesOf(seen), [
							versionFile(Arr.getUnsafe(filling.clones, at).committed)
						])
						const tree = yield* treeOf(sandbox, clone)
						deepStrictEqual(seen.files, tree)
					})
				)
			}),
	oracle: {
		kind: "specification",
		name: "a snapshot fills each submodule at the commit the snapshot's commit records, never the working tree's checkout"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: `\t\tcommit=\${entry##* }`,
			replacement: '\t\tcommit=$(git -C "$5/$path" rev-parse HEAD)',
			why: "Each submodule is filled at the commit its working tree has checked out, not the one the snapshot's commit records; the filled-submodule property fails."
		}
	]
})

export const collectedSnapshots = property.exhaust(finite(collectings), {
	box: "one key directory of every kind, fate and lock beside the one the run checks",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a key directory whose clones are all gone is collected",
		"a key directory kept by a clone still there among gone ones",
		"a key directory whose clones are gone kept by a live lock",
		"a stale lock keeps nothing",
		"a re-pointed clone counts as gone",
		"a repository with no origin remote, keyed by its path"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(entries) =>
			Effect.scoped(
				Effect.gen(function* () {
					c.noteAll(collectingFeatures(entries))
					const scratch = yield* dir
					const gateCheckout = yield* checkout
					const workspace = yield* lockfile
					const sandbox = sandboxOf(scratch, gateCheckout, workspace)
					const made = yield* Effect.forEach(entries, (entry, index) =>
						registered(sandbox, entry, index)
					)
					yield* Effect.forEach(made, (one) => befell(sandbox, one))
					const { clones } = yield* clonedRepository(sandbox, 1)
					yield* looked(sandbox, Arr.headNonEmpty(clones), 0, { stamp: false, stray: false })
					const left = yield* keys(sandbox)
					const entryKeys = Arr.map(made, (one) => one.key)
					deepStrictEqual(
						Arr.filter(left, (key) => Arr.contains(entryKeys, key)),
						Arr.sort(
							Arr.flatMap(made, (one) => (kept(one.entry) ? [one.key] : [])),
							Order.String
						)
					)
					deepStrictEqual(Arr.filter(left, (key) => !Arr.contains(entryKeys, key)).length, 1)
				})
			),
	oracle: {
		kind: "specification",
		name: "a run deletes each other key directory whose repository is gone (none of its listed clones still there under its key) and that no live run holds"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: "if hold try exclusive 1 7; then",
			replacement: "if true; then",
			why: "A collect deletes a key directory a live run holds, under that run's snapshot, so the run checks a half-deleted tree; the collection property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'if [ -d "$clone" ] && [ "$(key_of "$clone")" = "$(basename -- "$dir")" ]; then',
			replacement: 'if [ -d "$clone" ]; then',
			why: "A listed clone re-pointed at another repository still keeps its old key directory alive; the collection property fails."
		}
	]
})

export const sweptRun = property.exhaust(finite(sweeps), {
	box: "a run of one repository's push gate in each phase of its life, its clone still there or re-pointed, while another repository's run collects garbage beside it",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a run holding its key before it claims a snapshot keeps it",
		"a run filling its snapshot keeps it",
		"a run checking keeps its snapshot",
		"a process a run left in its snapshot keeps it",
		"a run's hold alone keeps a repository its registry reads gone",
		"an exited run's repository read gone is collected"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(sweep) =>
			Effect.scoped(
				Effect.gen(function* () {
					c.noteAll(sweepFeatures(sweep))
					const scratch = yield* dir
					const gateCheckout = yield* checkout
					const workspace = yield* lockfile
					const sandbox = sandboxOf(scratch, gateCheckout, workspace)
					const run = yield* sweptBeside(sandbox, sweep)
					deepStrictEqual(run.left, keptThrough(sweep))
					deepStrictEqual(run.status, 0)
					deepStrictEqual(run.seen.files, run.tree)
					deepStrictEqual(run.seen.stamps, ["stamp-warm"])
				})
			),
	oracle: {
		kind: "specification",
		name: "a run holds its repository's key from before it claims a snapshot until the last process it started exits, so a collect beside it never deletes its key directory or snapshot whatever the registry reads, and takes the directory of a repository read gone once nothing of its runs is left"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: "if hold try exclusive 1 7; then",
			replacement: "if true; then",
			why: "The collect takes the registry alone as its test of a live run, as every gate before the flock(1) holds did: a key directory whose clones read gone is renamed away and removed under the run that holds it (effect-openapi-cli-generator's 930250a4b854, under four pushes in a row); the swept-run property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: "hold wait shared 1 8",
			replacement: ":",
			why: "A run never holds its key, so a collect beside it takes the key alone and deletes the directory under the run, whatever phase it is in; the swept-run property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: '\tclaim "$1"\n',
			replacement:
				'\tclaim "$1"\n\tperl -e \'use Fcntl ":flock"; open(my $key, ">>&=", 8) or die; flock($key, LOCK_UN) or die\'\n',
			why: "A run lets go of its key once it holds a snapshot, as if the snapshot's lock kept the directory, but the collect reads the key's lock alone, so it deletes the directory under a run filling or checking its snapshot and under a process the run left there; the swept-run property fails."
		}
	]
})

export const pushCall = property.exhaust(finite(pushCalls), {
	box: "a push-mode run called by hand, as git calls the pre-push hook, or as a lane mistook the pre-push script for the gate",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a run by hand with no arguments is taken",
		"git's call by a remote's name is taken",
		"git's call by a URL is taken",
		"a lane's run index with a command is refused",
		"a lane's run index alone, two arguments as git's are, is refused"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(call) =>
			Effect.gen(function* () {
				c.noteAll(pushCallFeatures(call))
				const scratch = yield* dir
				const gateCheckout = yield* checkout
				const workspace = yield* lockfile
				const sandbox = sandboxOf(scratch, gateCheckout, workspace)
				const { origin, clones } = yield* clonedRepository(sandbox, 1)
				const done = yield* pushedAs(sandbox, Arr.headNonEmpty(clones), origin, call)
				const refused = done.status === 2 && Str.includes(REFUSED_CALL)(done.stderr)
				deepStrictEqual(refused, !takesCall(call))
			}),
	oracle: {
		kind: "specification",
		name: "the push mode takes git's pre-push arguments, a remote and its URL or a URL twice, or none, and refuses any other call, which it would otherwise ignore and check HEAD"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original:
				'if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || { [ "$1" != "$2" ] && ! git remote get-url -- "$1" >/dev/null 2>&1; }; }; then',
			replacement: "if false; then",
			why: "The push mode takes any call, so a lane's `run index pnpm check` through the pre-push script checks HEAD and passes on an index it never read (COPYDIFF's lint red); the push-call property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original:
				'if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || { [ "$1" != "$2" ] && ! git remote get-url -- "$1" >/dev/null 2>&1; }; }; then',
			replacement: 'if [ "$#" -ne 0 ] && [ "$#" -ne 2 ]; then',
			why: "The push mode takes any two arguments as git's, so a lane's `run index` checks HEAD; the push-call property fails."
		}
	]
})

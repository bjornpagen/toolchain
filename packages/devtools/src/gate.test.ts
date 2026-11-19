/**
 * The gate's snapshot cache (bin/gate.sh): snapshots per repository, shared by every clone of it however it writes its
 * origin, each with the objects of the clone whose commit is checked; a run that claims the first snapshot no live run
 * holds, never waiting; and a snapshot whose repository is gone collected.
 *
 * Each case draws the shape of a scenario (how many clones of one repository and how they write its URL, what each
 * commits and leaves uncommitted, which clone each run checks, whether the repository has a submodule and at which
 * commit, what a run's command leaves behind, which snapshots live or exited runs hold, the key directories beside it
 * and what became of their clones and locks), builds it from real git repositories in a scratch directory of its own,
 * and runs the gate over its clones with a cache of its own (XDG_CACHE_HOME), so nothing here touches the real cache.
 * Oracle: the specification, the gate's header: a command the gate runs on a commit sees exactly that commit's files, a
 * submodule's at the commit it records; a file a first run left under .gitignore (node_modules) is still there for a
 * second clone's first run, which is what a warm snapshot is; a run beside live runs takes the first snapshot none of
 * them holds, or a new one; and a run collects every other key directory whose repository is gone and that holds no
 * live lock, leaving the old per-path layout alone.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Order } from "effect"
import {
	alternatesOf,
	befell,
	checkedClones,
	claimedBy,
	claimedSlot,
	claimingFeatures,
	claimings,
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
	keys,
	looked,
	objectsOf,
	onlyKey,
	pushLocks,
	registered,
	sandboxOf,
	sharingFeatures,
	sharings,
	slotted,
	spelledClones,
	stampsBefore,
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
	box: "the push mode's first two snapshots, each with no lock, held by a live run or locked by an exited one, when a run comes",
	needs: { dir: Scratch.dir, checkout: Checkout.dir, lockfile: workspaceLockfile },
	situations: [
		"a run claims a snapshot no run holds",
		"a run passes a snapshot a live run holds",
		"a run takes a snapshot whose run has exited",
		"every snapshot held: a run makes a new one"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(slots) =>
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
				yield* Effect.forEach(slots, (slot, at) => slotted(sandbox, key, slot, at))
				const claimed = claimedSlot(slots)
				const run = yield* claimedBy(sandbox, clone)
				deepStrictEqual(run.snapshot, `push.${String(claimed)}`)
				const tree = yield* treeOf(sandbox, clone)
				deepStrictEqual(run.seen.files, tree)
				const locks = yield* pushLocks(sandbox, key)
				deepStrictEqual(
					locks,
					Arr.flatMap(slots, (slot, at) => (slot === "no lock" || at === claimed ? [] : [at]))
				)
			}),
	oracle: {
		kind: "specification",
		name: "a run claims the first snapshot of its mode that no live run holds, a new one when every one is held, never waits, and frees only the one it claimed"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'snapshot="$cache/$1.$n"',
			replacement: 'snapshot="$cache/$1.0"',
			why: "Every run checks in the first snapshot whatever holds it, so a run beside a live one rewrites the files that run is checking, and frees that run's lock when it exits; the claimed-snapshot property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: '\t\t\trm -rf "$cache/$1.$n.lock"',
			replacement: "\t\t\tn=$((n + 1))",
			why: "A snapshot whose run exited without freeing it is never claimed again, so every crash leaves a snapshot no run uses; the claimed-snapshot property fails."
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
		"a repository with no origin remote, keyed by its path",
		"an old-layout directory left alone",
		"a held old-layout directory left alone"
	],
	check:
		({ dir, checkout, lockfile }, c) =>
		(entries) =>
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
			}),
	oracle: {
		kind: "specification",
		name: "a run deletes each other key directory whose repository is gone (none of its listed clones still there under its key) and that holds no live lock, and leaves the old per-path layout alone"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/bin/gate.sh",
			original: '[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0',
			replacement: '[ -n "$pid" ] && return 0',
			why: "A lock whose run has exited still holds its key directory, so a snapshot whose repository is gone stays while a stale pid file names it; the collection property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: '[ -f "$dir/clones" ] || continue',
			replacement: '[ -d "$dir" ] || continue',
			why: "A directory of the old per-path layout, which lists no clones, is collected as gone, under an older gate that may be running in it; the collection property fails."
		},
		{
			file: "packages/devtools/bin/gate.sh",
			original: 'if [ -d "$clone" ] && [ "$(key_of "$clone")" = "$(basename -- "$dir")" ]; then',
			replacement: 'if [ -d "$clone" ]; then',
			why: "A listed clone re-pointed at another repository still keeps its old key directory alive; the collection property fails."
		}
	]
})

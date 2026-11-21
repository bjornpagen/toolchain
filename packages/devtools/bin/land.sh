#!/bin/sh
# toolchain-land (`pnpm land`): lands this jj workspace's finished commits on the trunk of its repository's hub, the
# bare repository on this machine that lanes land on (the remote `hub`), behind the thin gate, and lets nothing wait
# for anything. The whole gate is not the lane's: trunk@<repo>, the one job between the hub and the repository's
# upstream, runs the repository's `trunk` script on a batch of landings and pushes upstream only what passed. Each step
# is a command a lane would type (the jj-lanes skill):
#
#   jj git fetch --remote hub                     the hub's trunk, <trunk>@hub, which the workspace tracks
#   jj bookmark set <trunk> -r <trunk>@hub -B     the workspace's trunk bookmark is the hub's again, whatever an
#                                                 earlier landing whose push was refused left it at
#   jj rebase -b @ -o <trunk>@hub                 the workspace's commits onto it; a commit that conflicts is refused,
#                                                 and the conflict stays in the workspace for its lane to resolve
#   jj fix                                        the formatter on the files the landing's commits change, each commit
#                                                 rewritten as formatted: the account's fixer (the workbench's jj
#                                                 part), the workspace's own oxfmt, which keeps the files its
#                                                 configuration ignores as they are
#   the thin gate                                 what only the lane can know: the lockfile agrees with the manifests
#                                                 (pnpm install --frozen-lockfile), the repository's own check of its
#                                                 generated files (its `land:generated` script, where it has one), the
#                                                 typecheck of what changed (`pnpm types`, turbo replaying every
#                                                 package whose inputs did not), and the test files the landing adds or
#                                                 changes, by path, each in the package whose test.config.ts holds it
#   jj bookmark set <trunk> -r @-                 a forward move, which jj refuses for a commit off the trunk
#   jj git push --remote hub -b <trunk>           a fast-forward of the hub's trunk, which jj pushes only while the hub
#                                                 still holds the trunk it fetched; trunk@<repo> starts by itself
#
# A push the hub refuses because its trunk moved since the fetch (another landing's) is landed again from the fetch:
# rebased onto the new trunk and gated on what lands then. Whoever pushes first wins, and the other lands on top of it.
#
# The trunk is the hub's own word: its `trunk.branch` (git config in the hub, which the workbench's trunk part writes
# from repos.list and trunk@<repo> reads), main for most repositories and staging for edullm, whose main is production.
# A landing pushes that branch and no other, and refuses a hub that states none: there is no default to fall on main.
# A landing also refuses a workspace whose working copy (@) holds changes, since it lands @- and the changes would be left behind (`jj
# commit` finishes them), and a landing of nothing. After each rebase it checks out every submodule at the commit the
# workspace's commit records (`git submodule update`, the one git command a jj workspace keeps), since jj checks out no
# submodule.
set -eu

newline='
'

refuse() {
	printf 'toolchain-land: %s\n' "$1" >&2
	exit 1
}

root=$(jj workspace root) || refuse "land from a jj workspace of the repository"
cd "$root"
hub=$(git config --get remote.hub.url) || refuse "this workspace has no remote named hub: land on the repository's hub"
branch=$(git --git-dir="$hub" config --get trunk.branch) ||
	refuse "the hub ($hub) states no trunk branch (git config trunk.branch): the workbench's trunk part writes it"
[ "$(jj log --no-graph -r @ -T empty)" = true ] ||
	refuse "the working copy holds changes, which a landing of @- would leave behind: jj commit them first"

# runner <file>: the directory of the runner config (test.config.ts) nearest above <file>, none when no config holds it.
runner() {
	directory=$(dirname -- "$1")
	until [ -f "$directory/test.config.ts" ]; do
		[ "$directory" != . ] || return 1
		directory=$(dirname -- "$directory")
	done
	printf '%s\n' "$directory"
}

while :; do
	jj git fetch --remote hub
	trunk=$(jj log --no-graph -r "$branch@hub" -T commit_id)
	jj --quiet bookmark track "$branch@hub"
	jj bookmark set "$branch" -r "$branch@hub" --allow-backwards
	jj rebase -b @ -o "$branch@hub"
	conflicted=$(jj log --no-graph -r "($branch@hub..@-) & conflicts()" -T 'commit_id.short() ++ " "')
	[ -z "$conflicted" ] ||
		refuse "these commits conflict with $branch ($trunk), and nothing was pushed: $conflicted- resolve them (jj st) and land again"
	[ "$(jj log --no-graph -r @- -T commit_id)" != "$trunk" ] || refuse "nothing to land: @- is $branch@hub"
	jj fix -s "$branch@hub..@"
	git submodule update --init --recursive -q
	pnpm install --frozen-lockfile --prefer-offline --reporter=silent
	pnpm run --if-present land:generated
	pnpm types
	# The test files the landing adds or changes, each run by path in the package whose runner config holds it.
	tests=$(jj diff --from "$branch@hub" --to @- --name-only | grep -E '\.test\.(ts|tsx|mts|cts)$' || true)
	set -f
	IFS=$newline
	for file in $tests; do
		[ -f "$file" ] || continue
		package=$(runner "$file") || continue
		printf '%s\n' "$package"
	done | sort -u | while IFS= read -r package; do
		files=
		for file in $tests; do
			[ -f "$file" ] && [ "$(runner "$file" || true)" = "$package" ] || continue
			files="$files${newline}${file#"$package/"}"
		done
		printf 'toolchain-land: toolchain-test run in %s:%s\n' "$package" "$files" >&2
		# shellcheck disable=SC2086
		(cd "$package" && pnpm exec toolchain-test run $files)
	done
	unset IFS
	set +f
	commit=$(jj log --no-graph -r @- -T commit_id)
	jj bookmark set "$branch" -r @-
	printf 'toolchain-land: pushing %s onto the hub'"'"'s %s %s\n' "$commit" "$branch" "$trunk" >&2
	if jj git push --remote hub -b "$branch"; then
		exit 0
	fi
	jj git fetch --remote hub
	[ "$(jj log --no-graph -r "$branch@hub" -T commit_id)" != "$trunk" ] ||
		refuse "the push of $commit failed while the hub's $branch stayed at $trunk"
	printf 'toolchain-land: %s moved while %s was gated: landing again on it\n' "$branch" "$commit" >&2
done

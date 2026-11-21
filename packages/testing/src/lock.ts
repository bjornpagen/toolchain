/**
 * A need's kernel lock, the toolchain's one (pg/hold.ts lockHeld): the exclusive flock(2) on a file, waited for and held
 * for the enclosing scope by the toolchain's holder of kernel locks (scripts/hold.pl), which takes the cluster's
 * lifecycle lock and a run's lease too. Its wait is declared to the runner's guards as a wait for that file's lock,
 * judged by the work of the process that holds it, so a wait behind a holder that works is no stall. A need that builds
 * an artifact once for every worker of a run takes it on a file beside the artifact: the first to hold it builds, and
 * the rest find it built once the lock is theirs. It fails with HoldFailed when its holder ends before it holds. A need
 * that took flock(1) through a child process, a second lock, takes this one instead (metis's browser suites).
 */
export { HoldFailed, lockHeld } from "#pg/hold.ts"

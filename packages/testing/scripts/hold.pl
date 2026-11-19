#!/usr/bin/env perl
# hold.pl, the toolchain's one holder of kernel locks: every lock the toolchain takes on a file is flock(2)'s, taken by
# this program, which Node cannot take (it has no flock) and a shell takes only through flock(1), which util-linux
# installs and macOS lacks; perl, which Debian, Ubuntu and macOS all install, has flock. Its takers are a cluster's
# lifecycle lock and a run's lease on a cluster (src/pg/hold.ts) and the gate's key and snapshot locks
# (packages/devtools/bin/gate.sh).
#
#   perl hold.pl CLAIM...
#   CLAIM is   gate TARGET                              TARGET's exclusive lock, waited for, held while the claims
#                                                       after it are taken and let go once they all hold
#          or  wait shared|exclusive NEED TARGET...     NEED of the TARGETs: those free now, then the rest waited for
#                                                       in order, so a claim that waits holds what it took meanwhile
#          or  try shared|exclusive NEED TARGET...      NEED of the TARGETs free now, or the whole run fails
#   TARGET is  an absolute path, a file this program opens (made when it is absent), or a descriptor's number, a file
#              its caller opened and passes on
#
# The claims are taken in order, all or nothing: a `try` claim that finds fewer than NEED of its targets free lets go of
# every lock this run took and exits 1, saying nothing, which is a taken lock's answer and no failure; anything else
# that goes wrong lets go of them too, says why on standard error and exits 2. Once every claim holds, the locks are
# held by whoever holds their files. A lock on a caller's descriptor is the caller's: the descriptor shares this
# program's open file, and flock(2)'s lock belongs to the open file, so it stays when this program exits and goes when
# the last process holding the file closes it or exits, however it exits (a shell's descriptor, which every process it
# starts inherits). When the claims name a file this program opened, it says `held` on standard output and holds
# every lock until its standard input ends, which the kernel ends with the process holding the other end, however that
# process ends.
#
# A wait is in the kernel: a waiter holds no connection, no transaction and no snapshot of anything. Waits close no
# cycle when every taker of more than one lock that may wait for one takes them under one gate: only the gate's holder
# then waits for a lock while it holds others, and whoever holds them all waits for nothing.
use strict;
use warnings;
use Errno qw(EWOULDBLOCK);
use Fcntl qw(:flock);

# Every lock this run took, and the gates among them.
my @taken;
my @gates;

# fail(message): lets go of every lock this run took, says why and exits 2.
sub fail {
	my ($message) = @_;
	flock($_, LOCK_UN) for @taken;
	print STDERR "hold.pl: $message\n";
	exit 2;
}

# The claims, each a verb, a lock kind, a need and its targets' files, opened before any is locked, so a claim that
# names no file it can open takes nothing.
my @claims;
my $opened = 0;
my @words = @ARGV;
my %verbs = (gate => 1, wait => 1, try => 1);
my %kinds = (shared => LOCK_SH, exclusive => LOCK_EX);

sub file_of {
	my ($target) = @_;
	my $file;
	if ($target =~ m{\A/}) {
		open($file, ">>", $target) or fail("$target: $!");
		$opened = 1;
	} elsif ($target =~ /\A[0-9]+\z/) {
		open($file, ">>&=", $target) or fail("descriptor $target: $!");
	} else {
		fail("$target is neither an absolute path nor a descriptor's number");
	}
	return $file;
}

while (@words) {
	my $verb = shift @words;
	exists $verbs{$verb} or fail("$verb is no claim: gate, wait or try");
	if ($verb eq "gate") {
		my $target = shift(@words) // fail("a gate names no target");
		push @claims, { verb => $verb, lock => LOCK_EX, need => 1, files => [file_of($target)] };
		next;
	}
	my $kind = shift(@words) // fail("a $verb claim names no kind of lock");
	exists $kinds{$kind} or fail("$kind is no kind of lock: shared or exclusive");
	my $need = shift(@words) // fail("a $verb claim names no need");
	$need =~ /\A[1-9][0-9]*\z/ or fail("$need is no need: a whole number from 1");
	my @targets;
	push @targets, shift(@words) while @words && !exists $verbs{ $words[0] };
	@targets >= $need or fail("a $verb claim of $need names " . scalar(@targets) . " targets");
	push @claims, { verb => $verb, lock => $kinds{$kind}, need => $need, files => [map { file_of($_) } @targets] };
}
@claims or fail("usage: hold.pl CLAIM..., each gate TARGET, wait KIND NEED TARGET... or try KIND NEED TARGET...");

for my $claim (@claims) {
	my @files = @{ $claim->{files} };
	my %mine;
	for my $at (0 .. $#files) {
		last if keys(%mine) >= $claim->{need};
		if (flock($files[$at], $claim->{lock} | LOCK_NB)) {
			$mine{$at} = 1;
			push @taken, $files[$at];
		} elsif ($! != EWOULDBLOCK) {
			fail("flock: $!");
		}
	}
	if (keys(%mine) < $claim->{need}) {
		if ($claim->{verb} eq "try") {
			flock($_, LOCK_UN) for @taken;
			exit 1;
		}
		for my $at (0 .. $#files) {
			last if keys(%mine) >= $claim->{need};
			next if $mine{$at};
			flock($files[$at], $claim->{lock}) or fail("flock: $!");
			$mine{$at} = 1;
			push @taken, $files[$at];
		}
	}
	push @gates, @files if $claim->{verb} eq "gate";
}
flock($_, LOCK_UN) for @gates;
exit 0 unless $opened;
$| = 1;
print "held\n";
while (defined(my $line = <STDIN>)) { }
exit 0;

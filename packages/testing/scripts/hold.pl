#!/usr/bin/env perl
# hold.pl, the toolchain's one holder of kernel locks: every lock the toolchain takes on a file is flock(2)'s, taken by
# this program, which Node cannot take (it has no flock) and a shell takes only through flock(1), which util-linux
# installs and macOS lacks; perl, which Debian, Ubuntu and macOS all install, has flock. Its takers are a cluster's
# lifecycle lock and a run's lease on a cluster family (src/pg/hold.ts, src/pg/lease.ts) and the gate's key and
# snapshot locks (packages/devtools/bin/gate.sh).
#
#   perl hold.pl CLAIM...
#   CLAIM is   wait shared|exclusive NEED TARGET...     NEED of the TARGETs: those free now, then the rest waited for
#                                                       in order, so a claim that waits holds what it took meanwhile
#          or  try shared|exclusive NEED TARGET...      NEED of the TARGETs free now, or the whole run fails
#          or  lease NEED CHOOSE QUEUE MEMBER...        NEED slots of a family's members, all or none (a lease, below),
#                                                       the only claim of its run
#   MEMBER is  member SLOT DOOR [SLOT DOOR]...          a member's slots, each with its door
#   TARGET is  an absolute path, a file this program opens (made when it is absent), or a descriptor's number, a file
#              its caller opened and passes on; CHOOSE, QUEUE, SLOT and DOOR are absolute paths
#
# The claims are taken in order, all or nothing: a `try` claim that finds fewer than NEED of its targets free lets go of
# every lock this run took and exits 1, saying nothing, which is a taken lock's answer and no failure; anything else
# that goes wrong lets go of them too, says why on standard error and exits 2. Once every claim holds, the locks are
# held by whoever holds their files. A lock on a caller's descriptor is the caller's: the descriptor shares this
# program's open file, and flock(2)'s lock belongs to the open file, so it stays when this program exits and goes when
# the last process holding the file closes it or exits, however it exits (a shell's descriptor, which every process it
# starts inherits). When the claims name a file this program opened, it says `held` on standard output, a lease
# followed by the member of each slot it holds (below), and holds every lock until its standard input ends, which the
# kernel ends with the process holding the other end, however that process ends.
#
# A lease is NEED of the members' slots, held all at once or not at all, each slot one worker's place on its member. A
# slot is free when its lock and its door's are: a door is held only by the queue's holder, which shields with it the
# one slot it waits for. Every look at the slots is under the CHOOSE lock, which is held only while this program looks,
# taking free slots without waiting, never while it waits, so its holder waits for nothing. A lease that NEED free slots
# meet takes them there at once, whatever waits elsewhere: each from the member where it holds fewest, then the one with
# the most free slots, the earlier member on a tie, so a lease spreads over the members and leases taken one after
# another fill them evenly: N leases of one slot land on N members. A lease they do not meet lets go of what it looked
# at and takes the QUEUE lock, holding nothing while it waits for it, so leases that wait wait for the queue's holder,
# in the kernel's order. The queue's holder takes no free slot while it cannot finish, so leases that fit go on beside
# it, and it finishes once the slots it holds and the free ones meet NEED, taking those it lacks; until then it waits
# for one slot another lease holds, on the member where it holds fewest, the earlier on a tie, its door held first under
# CHOOSE. flock(2) waits for one lock and never for the first of several, so the queue's holder is bound to that slot
# while another may free; but no lease takes a slot whose door is held, so when the slot is let go it is the queue's
# holder's, however long the kernel takes to wake it: each slot it waits for is its own at that slot's next release, and
# no lease that fits starves it. No wait closes a cycle: only the queue's holder holds slots while it waits, and every
# lease whose slot it waits for holds all its own and waits for nothing. The QUEUE lock is the file an older toolchain's
# holder takes as its gate and holds while it waits for slots (`gate.lock`), so such a holder and the queue's holder
# never both hold slots while they wait.
use strict;
use warnings;
use Errno qw(EWOULDBLOCK);
use Fcntl qw(:flock);

# Every lock this run took.
my @taken;

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
my %verbs = (wait => 1, try => 1, lease => 1);
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

sub path_of {
	my ($what, $target) = @_;
	defined($target) && $target =~ m{\A/} or fail("a lease's $what is no absolute path");
	return file_of($target);
}

sub need_of {
	my ($verb) = @_;
	my $need = shift(@words) // fail("a $verb claim names no need");
	$need =~ /\A[1-9][0-9]*\z/ or fail("$need is no need: a whole number from 1");
	return $need;
}

while (@words) {
	my $verb = shift @words;
	exists $verbs{$verb} or fail("$verb is no claim: wait, try or lease");
	if ($verb eq "lease") {
		my $need = need_of($verb);
		my $choose = path_of("choose lock", shift @words);
		my $queue = path_of("queue", shift @words);
		my @members;
		while (@words && $words[0] eq "member") {
			shift @words;
			my @slots;
			while (@words && $words[0] ne "member" && !exists $verbs{ $words[0] }) {
				my $slot = path_of("slot", shift @words);
				push @slots, { slot => $slot, door => path_of("door", shift @words) };
			}
			@slots or fail("a lease's member names no slot");
			push @members, \@slots;
		}
		@members or fail("a lease names no member");
		my $slots = 0;
		$slots += @$_ for @members;
		$slots >= $need or fail("a lease of $need names $slots slots");
		push @claims, { verb => $verb, need => $need, choose => $choose, queue => $queue, members => \@members };
		next;
	}
	my $kind = shift(@words) // fail("a $verb claim names no kind of lock");
	exists $kinds{$kind} or fail("$kind is no kind of lock: shared or exclusive");
	my $need = need_of($verb);
	my @targets;
	push @targets, shift(@words) while @words && !exists $verbs{ $words[0] };
	@targets >= $need or fail("a $verb claim of $need names " . scalar(@targets) . " targets");
	push @claims, { verb => $verb, lock => $kinds{$kind}, need => $need, files => [map { file_of($_) } @targets] };
}
@claims or fail("usage: hold.pl CLAIM..., each wait KIND NEED TARGET..., try KIND NEED TARGET... or lease NEED CHOOSE"
	. " QUEUE MEMBER...");
@claims == 1 or !grep { $_->{verb} eq "lease" } @claims or fail("a lease is the only claim of its run");

# taken_now(file): the file's exclusive lock if it is free now, without waiting.
sub taken_now {
	my ($file) = @_;
	return 1 if flock($file, LOCK_EX | LOCK_NB);
	$! == EWOULDBLOCK or fail("flock: $!");
	return 0;
}

# A lease's run: its claim, the slots it holds as [member, slot], whether it holds each, and whether each was free at
# its last look.
my $lease;
my @mine;
my %ours;
my %seen_free;

# free(): under CHOOSE, every slot this lease does not hold whose lock and door are free now, by member, each slot's
# lock taken; its door let go at once.
sub free {
	my @found;
	%seen_free = ();
	for my $member (0 .. $#{ $lease->{members} }) {
		my @slots = @{ $lease->{members}[$member] };
		push @found, [];
		for my $at (0 .. $#slots) {
			next if $ours{"$member $at"};
			next unless taken_now($slots[$at]{door});
			if (taken_now($slots[$at]{slot})) {
				push @{ $found[$member] }, $at;
				$seen_free{"$member $at"} = 1;
			}
			flock($slots[$at]{door}, LOCK_UN);
		}
	}
	return @found;
}

# keep(count, found): `count` of the found slots kept, each from the member where this lease holds fewest, then the one
# with the most found left, then the earlier; the rest let go.
sub keep {
	my ($count, @found) = @_;
	my %held;
	$held{ $_->[0] }++ for @mine;
	for (1 .. $count) {
		my $best;
		for my $member (grep { @{ $found[$_] } } 0 .. $#found) {
			$best //= $member;
			my ($here, $there) = ($held{$member} // 0, $held{$best} // 0);
			$best = $member if $here < $there || ($here == $there && @{ $found[$member] } > @{ $found[$best] });
		}
		my $at = shift @{ $found[$best] };
		push @mine, [$best, $at];
		$held{$best}++;
		$ours{"$best $at"} = 1;
		push @taken, $lease->{members}[$best][$at]{slot};
	}
	for my $member (0 .. $#found) {
		flock($lease->{members}[$member][$_]{slot}, LOCK_UN) for @{ $found[$member] };
	}
}

# fits(): under CHOOSE, whether the free slots meet what this lease lacks, which it then holds.
sub fits {
	my @found = free();
	my $free = 0;
	$free += @$_ for @found;
	my $lacks = $lease->{need} - @mine;
	keep($free >= $lacks ? $lacks : 0, @found);
	return $free >= $lacks;
}

# shield(): under CHOOSE, the slot the queue's holder waits for, its door held: one it does not hold and another lease
# does (it was not free at the look fits() took), on the member where it holds fewest, the earlier member and slot on a
# tie.
sub shield {
	my %held;
	$held{ $_->[0] }++ for @mine;
	my $best;
	for my $member (0 .. $#{ $lease->{members} }) {
		my @slots = @{ $lease->{members}[$member] };
		my ($at) = grep { !$ours{"$member $_"} && !$seen_free{"$member $_"} } 0 .. $#slots;
		next unless defined $at;
		$best = [$member, $at] if !defined($best) || ($held{$member} // 0) < ($held{ $best->[0] } // 0);
	}
	defined $best or fail("a lease of $lease->{need} lacks slots and finds none another lease holds");
	my $slot = $lease->{members}[ $best->[0] ][ $best->[1] ];
	taken_now($slot->{door}) or fail("a door is held beside the queue's holder");
	return $best;
}

if ($claims[0]{verb} eq "lease") {
	$lease = $claims[0];
	flock($lease->{choose}, LOCK_EX) or fail("flock: $!");
	my $fit = fits();
	flock($lease->{choose}, LOCK_UN);
	if (!$fit) {
		flock($lease->{queue}, LOCK_EX) or fail("flock: $!");
		push @taken, $lease->{queue};
		while (1) {
			flock($lease->{choose}, LOCK_EX) or fail("flock: $!");
			last if fits();
			my $waited = shield();
			flock($lease->{choose}, LOCK_UN);
			my $slot = $lease->{members}[ $waited->[0] ][ $waited->[1] ];
			flock($slot->{slot}, LOCK_EX) or fail("flock: $!");
			push @mine, $waited;
			$ours{"$waited->[0] $waited->[1]"} = 1;
			push @taken, $slot->{slot};
			flock($slot->{door}, LOCK_UN);
		}
		flock($lease->{choose}, LOCK_UN);
		flock($lease->{queue}, LOCK_UN);
	}
	$| = 1;
	print join(" ", "held", map { $_->[0] } @mine), "\n";
	while (defined(my $line = <STDIN>)) { }
	exit 0;
}

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
}
exit 0 unless $opened;
$| = 1;
print "held\n";
while (defined(my $line = <STDIN>)) { }
exit 0;

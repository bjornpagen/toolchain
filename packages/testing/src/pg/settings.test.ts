/**
 * A member's predicate lock settings (pg/settings.ts), over every sizing a run's family can take: it promotes a
 * relation's page and tuple locks to one relation lock past production's 1023, whatever its room; a member of a room
 * for its workers holds the least max_pred_locks_per_transaction whose table, sized for every backend its settings
 * make, holds its room, and never fewer than PostgreSQL accepts; a member of production's room holds 2048 a backend;
 * and every member's table stays one a read of pg_locks copies in one allocation. Oracle: the specification,
 * PostgreSQL 19.0's own arithmetic over the settings (predicate.c MaxPredicateChildLocks and NPREDICATELOCKTARGETENTS,
 * postinit.c InitializeMaxBackends), stated in the check.
 */
import { Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { boolean, int } from "#gen.ts"
import { defaults, valueOf } from "#pg/settings.fixtures.ts"
import { fixedSettings, sizedSettings } from "#pg/settings.ts"
import { localCluster, type PredicateRoom } from "#pg/spec.ts"
import { property } from "#property.ts"

/**
 * A sizing a family can take: its members and the workers one serves, the machine's memory and a busy backend's, its
 * replication, and its predicate room, production's a backend or `targets` a worker.
 */
type Drawn = Readonly<{
	members: number
	share: number
	machineGiB: number
	backendMiB: number
	senders: boolean
	room: PredicateRoom
}>

export const predicateSettingsHoldTheRoom = property.explore(
	(source): Drawn => ({
		members: source.draw(int(1, 4)),
		share: source.draw(int(1, 64)),
		machineGiB: source.draw(int(1, 256)),
		backendMiB: source.draw(int(1, 256)),
		senders: source.draw(boolean),
		room: source.draw(boolean)
			? { kind: "perWorker", targets: source.draw(int(1, 4096)) }
			: { kind: "perBackend" }
	}),
	{
		needs: {},
		situations: [
			"a room at PostgreSQL's least a backend",
			"a room above the least",
			"production's a backend",
			"connections bound by pg_locks"
		],
		check:
			(_resources, c) =>
			({ members, share, machineGiB, backendMiB, senders, room }) =>
				Effect.sync(() => {
					const cluster = localCluster({
						unit: "settings-case",
						network: { kind: "socket" },
						owner: "owner",
						template: "template",
						extensions: [],
						ownerParameters: [],
						durability: "throwaway",
						sizing: {
							kind: "workers",
							family: { kind: "one" },
							connections: { kind: "capacity", backendBytes: backendMiB * 1024 * 1024 },
							replication: senders ? { kind: "capacity" } : { kind: "default" },
							sharedBuffers: { kind: "default" },
							locks: { kind: "default" },
							predicateLocks: room
						}
					})
					const settings = [
						...fixedSettings(cluster),
						...sizedSettings(cluster, members, share, machineGiB * 1024 ** 3, 8192)
					]
					const connections = Option.getOrElse(valueOf(settings, "max_connections"), () => 0)
					const walSenders = Option.getOrElse(
						valueOf(settings, "max_wal_senders"),
						() => defaults.senders
					)
					const backends =
						connections +
						defaults.autovacuum +
						defaults.workers +
						walSenders +
						defaults.special +
						defaults.prepared
					const perTransaction = Option.getOrElse(
						valueOf(settings, "max_pred_locks_per_transaction"),
						() => 64
					)
					const perRelation = Option.getOrElse(
						valueOf(settings, "max_pred_locks_per_relation"),
						() => -2
					)
					const promotion =
						perRelation >= 0 ? perRelation : Math.trunc(perTransaction / -perRelation) - 1
					const needed = room.kind === "perWorker" ? share * room.targets : 0
					if (room.kind === "perWorker" && perTransaction === 10) {
						c.note("a room at PostgreSQL's least a backend")
					}
					if (room.kind === "perWorker" && perTransaction > 10) {
						c.note("a room above the least")
					}
					if (room.kind === "perBackend") {
						c.note("production's a backend")
					}
					const machineCapacity = Math.floor(
						(machineGiB * 1024 ** 3) / (backendMiB * 1024 * 1024 * members)
					)
					if (connections - 3 < machineCapacity) {
						c.note("connections bound by pg_locks")
					}
					assert.deepEqual(
						{
							promotion,
							held: perTransaction * backends >= needed,
							least:
								room.kind === "perBackend"
									? perTransaction === 2048
									: perTransaction >= 10 &&
										(perTransaction === 10 || (perTransaction - 1) * backends < needed),
							lockStatusFits: 2 * perTransaction * backends * 168 <= 0x3fffffff
						},
						{ promotion: 1023, held: true, least: true, lockStatusFits: true }
					)
				}),
		oracle: {
			kind: "specification",
			name: "every member promotes a relation's predicate locks past 1023; a room's member holds the least max_pred_locks_per_transaction whose table, at PostgreSQL's MaxBackends of its settings, holds share times its room, never under PostgreSQL's 10; production's holds 2048; and 2 locks a target times 168 bytes a lock stays within PostgreSQL's 1 GB allocation"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/pg/settings.ts",
				original: `\t["max_pred_locks_per_relation", \`\${relationPromotion}\`],\n`,
				replacement: "",
				why: "A member's relation promotion is left to PostgreSQL's default, max_pred_locks_per_transaction / 2 - 1, which moves with the room: a room's member at 10 promotes past 4 locks where production promotes past 1023, so a test's SERIALIZABLE transactions conflict where production's never would; the property fails."
			},
			{
				file: "packages/testing/src/pg/settings.ts",
				original:
					"\t\t\t: Math.max(minimumPredicateLocks, Math.ceil((share * room.targets) / backends))\n",
				replacement:
					"\t\t\t: Math.max(minimumPredicateLocks, Math.floor((share * room.targets) / backends))\n",
				why: "The room's count a backend is rounded down, so a member's table holds less than its workers' measured room and its transactions run out of shared memory (53200) below it; the property fails."
			},
			{
				file: "packages/testing/src/pg/settings.ts",
				original:
					"\t\t\t: Math.max(minimumPredicateLocks, Math.ceil((share * room.targets) / backends))\n",
				replacement: "\t\t\t: Math.ceil((share * room.targets) / backends)\n",
				why: "A small room gives a member fewer predicate locks a backend than PostgreSQL accepts, and its server refuses to start; the property fails."
			},
			{
				file: "packages/testing/src/pg/settings.ts",
				original: '\t\troom.kind === "perBackend"\n\t\t\t? predicateLocksPerTransaction\n',
				replacement: '\t\troom.kind !== "perBackend"\n\t\t\t? predicateLocksPerTransaction\n',
				why: "A room's member holds production's 2048 for every backend, the table that grows with its connections and senders, which every DROP INDEX of the member walks under every SSI LWLock (5.6 ms a drop at 3.19 million targets, 2026-11-22); the property fails."
			},
			{
				file: "packages/testing/src/pg/settings.ts",
				original: '\t\t(replication.kind === "capacity" ? admitted : defaultWalSenders) +\n',
				replacement: "\t\tdefaultWalSenders +\n",
				why: "A member's room is spread over the backends of PostgreSQL's default senders where each connection is a WAL sender too, so its table holds less or more than its room; the property fails."
			},
			{
				file: "packages/testing/src/pg/settings.ts",
				original:
					'\troom.kind === "perBackend" ? predicateLocksPerTransaction : minimumPredicateLocks\n',
				replacement: "\tminimumPredicateLocks\n",
				why: "A member of production's 2048 a backend admits as many connections as the machine's memory holds, so its predicate lock table outgrows what a read of pg_locks copies in one allocation (the shared server at 10,000 connections, 2026-11-21); the property fails."
			}
		]
	}
)

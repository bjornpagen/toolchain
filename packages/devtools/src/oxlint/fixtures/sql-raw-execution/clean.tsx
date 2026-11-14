import { type QueryPromise, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import type { PgAsyncPreparedQuery, PreparedQueryConfig } from "drizzle-orm/pg-core"
import { Pool, type PoolClient } from "pg"
import { copyFrom } from "pg-copy-streams"

const database = drizzle("postgres://fixture")

const pool = new Pool()

const stagingDefinition = () => sql`create temp table staging (id int)`

export const runStatement = (statement: QueryPromise<unknown>) => statement.execute()

export const runPrepared = (prepared: PgAsyncPreparedQuery<PreparedQueryConfig>) =>
	prepared.execute({ id: 1 })

export const native = () => pool.query("select 1")

export const copied = (client: PoolClient) => client.query(copyFrom("copy accounts from stdin"))

export const createStaging = () => database.execute(stagingDefinition())

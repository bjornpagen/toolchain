import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable } from "drizzle-orm/pg-core"
import { Pool } from "pg"

const accounts = pgTable("accounts", { id: integer().notNull() })

const database = drizzle("postgres://fixture")

const pool = new Pool()

const selection = database.select({ id: accounts.id }).from(accounts)

const stagingDefinition = () => sql`create temp table staging (id int)`

declare const client: { execute: (request: string) => Promise<unknown> }

declare const permissions: { query: (input: { name: string }) => Promise<unknown> }

declare const scope: { run: (work: (db: { execute: (statement: unknown) => unknown }) => unknown) => unknown }

export const run = () => database.execute(sql`select 1`) // violation

export const built = () => selection.execute() // violation

export const prepared = () => selection.prepare("accounts").execute() // violation

export const native = () => pool.query("select 1") // violation

export const raw = () => database.$client.query("select 1") // violation

export const createStaging = () => database.execute(stagingDefinition()) // violation

export const inScope = () => scope.run((db) => db.execute(sql`select 1`)) // violation

export const awaited = async () => await selection

export const counted = () => pool.totalCount

export const fetched = () => client.execute("https://example.com")

export const permitted = () => permissions.query({ name: "microphone" })

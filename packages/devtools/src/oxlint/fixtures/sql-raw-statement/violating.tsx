import { sql } from "drizzle-orm"
import { type AnyPgTable, integer, pgTable } from "drizzle-orm/pg-core"
import type { TypedQueryBuilder } from "drizzle-orm/query-builders/query-builder"

const accounts = pgTable("accounts", { id: integer().notNull() })

declare const builder: TypedQueryBuilder<Readonly<{ id: number }>>

export const selected = sql`select ${accounts.id} from ${accounts}` // violation

export const filtered = sql`where ${accounts.id} = 1` // violation

export const joined = sql`left join ${accounts} on true` // violation

export const grouped = sql`group by ${accounts.id}` // violation

export const combined = sql`${accounts.id} union ${accounts.id}` // violation

export const raw = sql.raw("now()") // violation

export const truncation = (table: AnyPgTable) => sql`truncate ${table} cascade` // violation

export const projected = sql`${builder.getSQL()} offset 0` // violation

export const scalar = sql`coalesce(${accounts.id}, 0)`

export const quoted = sql`'select'`

export const commented = sql`1 -- select`

export const word = sql`selection(${accounts.id})`

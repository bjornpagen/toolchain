import { sql } from "drizzle-orm"
import { type AnyPgTable, integer, pgTable } from "drizzle-orm/pg-core"
import type { TypedQueryBuilder } from "drizzle-orm/query-builders/query-builder"

const accounts = pgTable("accounts", { id: integer().notNull() })

declare const builder: TypedQueryBuilder<Readonly<{ id: number }>>

const tagged = (strings: TemplateStringsArray): string => strings.join("")

export const projected = sql`${builder.getSQL()} offset 0`

export const recursive = sql`with recursive ${sql.join([sql`a`, sql`b`], sql`, `)} ${builder}`

export const truncation = (table: AnyPgTable) => sql`truncate ${table} cascade`

export const scalar = sql`coalesce(${accounts.id}, 0)`

export const other = tagged`select 1`

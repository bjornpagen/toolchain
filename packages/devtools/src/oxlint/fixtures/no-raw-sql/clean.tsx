import { sql } from "drizzle-orm"
import { integer, pgTable } from "drizzle-orm/pg-core"

declare const column: string
declare const tag: (parts: TemplateStringsArray, ...values: ReadonlyArray<string>) => string

const accounts = pgTable("accounts", { id: integer().notNull() })

export const literal = "SELECT x::text"
export const arn = "arn:aws:iam::123456789012:role/reader"
export const pattern = "^(?::(\\d{2}))?$"
export const untagged = `SELECT ${column}::text`
export const otherTag = tag`SELECT ${column}::text`
export const quoted = sql`'a::b' AS "c::d"`
export const commented = sql`${accounts.id} -- ::text`
export const block = sql`/* x::text /* nested */ y::int */ ${accounts.id}`
export const dollar = sql`$tag$ x::text $tag$`
export const doubled = sql`'it''s::fine'`
export const plain = sql`lower(${accounts.id})`

import { sql } from "drizzle-orm"
import { alias, integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

const parent = alias(accounts, "parent")

const tagged = (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): string =>
	`${strings.join("")}${values.length}`

export const declared = sql`${accounts} AS ${parent}`

export const column = sql`${parent.id}`

export const other = tagged`${parent}`

import { integer, pgSchema, pgTable, text } from "drizzle-orm/pg-core"

const roster: ReadonlyArray<string> = ["id", "name"]

const app = pgSchema("app")

const registry = { table: (name: string, columns: unknown) => [name, columns] }

export const accounts = pgTable("accounts", { id: integer().notNull(), name: text() })

export const members = app.table("members", { id: integer().notNull() })

export const stageOf = (name: string) =>
	pgTable(name, Object.fromEntries(roster.map((column) => [column, text()])))

export const other = registry.table("other", roster)

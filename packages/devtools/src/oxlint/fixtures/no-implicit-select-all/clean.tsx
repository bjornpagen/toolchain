import { drizzle } from "drizzle-orm/node-postgres"
import { pgTable, text, uuid } from "drizzle-orm/pg-core"

const todos = pgTable("todos", { id: uuid().notNull(), title: text().notNull() })

const database = drizzle("postgres://fixture")

const fake = { select: (): ReadonlyArray<string> => [] }

declare const input: { select: () => void }

declare const config: { columns: { id: true } }

export const some = database.select({ id: todos.id }).from(todos)

export const inserted = database
	.insert(todos)
	.values({ id: "x", title: "y" })
	.returning({ id: todos.id })

export const other = fake.select()

export const highlighted = input.select()

export const found = database.query.todos.findMany({ columns: { id: true } })

export const spread = database.query.todos.findFirst({ ...config })

export const distinctOn = database.selectDistinctOn([todos.id], { id: todos.id }).from(todos)

import { drizzle } from "drizzle-orm/node-postgres"
import { pgTable, text, uuid } from "drizzle-orm/pg-core"

const todos = pgTable("todos", { id: uuid().notNull(), title: text().notNull() })

const database = drizzle("postgres://fixture")

declare const scope: { select: () => { from: (table: unknown) => unknown } }

export const all = database.select().from(todos) // violation

export const inserted = database.insert(todos).values({ id: "x", title: "y" }).returning() // violation

export const unchained = database.select() // violation

export const throughScope = scope.select().from(todos) // violation

export const distinct = database.selectDistinct().from(todos) // violation

export const distinctOn = database.selectDistinctOn([todos.id]).from(todos) // violation

export const found = database.query.todos.findMany() // violation

export const first = database.query.todos.findFirst({ where: { id: "x" } }) // violation

export const some = database.select({ id: todos.id }).from(todos)

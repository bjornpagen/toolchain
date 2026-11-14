import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, pgTable, uuid } from "drizzle-orm/pg-core"

const todos = pgTable("todos", { id: uuid().notNull(), done: boolean().notNull() })

const tx = drizzle("postgres://fixture")

const registry = new Map<string, number>()

declare const params: URLSearchParams

declare const counter: { update: (by: number) => number }

declare const scope: { run: (work: (db: { delete: (table: unknown) => { where: (condition: unknown) => unknown } }) => unknown) => unknown }

export const removeOne = tx.delete(todos).where(eq(todos.id, "x"))

export const flipOne = tx.update(todos).set({ done: true }).where(eq(todos.id, "x"))

export const forget = registry.delete("x")

export const unset = () => params.delete("x")

export const bumped = counter.update(1)

const removal = tx.delete(todos)

export const removeBound = removal.where(eq(todos.id, "x"))

const flipping = tx.update(todos).set({ done: false })

export const flipBound = flipping.where(eq(todos.id, "y"))

export const inScope = () => scope.run((db) => db.delete(todos).where(eq(todos.id, "z")))

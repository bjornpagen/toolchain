import { and, eq, type SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, pgTable, uuid } from "drizzle-orm/pg-core"

const todos = pgTable("todos", { id: uuid().notNull(), done: boolean().notNull() })

const tx = drizzle("postgres://fixture")

declare const scope: { run: (work: (db: { delete: (table: unknown) => unknown }) => unknown) => unknown }

declare const handle: { returning: () => unknown; delete: (table: unknown) => typeof handle }

export const wipe = tx.delete(todos) // violation

export const flip = tx.update(todos).set({ done: true }) // violation

const pending = tx.delete(todos) // violation

export const kept = pending

export const removeMatching = (filters: ReadonlyArray<SQL>) =>
	tx.delete(todos).where(and(...filters)) // violation

export const flipMaybe = (condition: SQL | undefined) =>
	tx
		.update(todos)
		.set({ done: true })
		.where(condition) // violation

const later = tx.delete(todos)

export const removeLater = (filters: ReadonlyArray<SQL>) => later.where(and(...filters)) // violation

export const removeNothing = tx.delete(todos).where(undefined) // violation

export const inScope = () => scope.run((db) => db.delete(todos)) // violation

export const returned = handle.delete(todos).returning() // violation

export const removeOne = tx.delete(todos).where(eq(todos.id, "x"))

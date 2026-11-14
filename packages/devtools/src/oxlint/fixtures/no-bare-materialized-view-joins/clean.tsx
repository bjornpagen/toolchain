import { eq, getViewName } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgMaterializedView, pgTable } from "drizzle-orm/pg-core"
import { ledgerTotals } from "#fixture/views.ts"

const accounts = pgTable("accounts", { id: integer().notNull() })

const totals = pgMaterializedView("totals", { id: integer().notNull() }).existing()

const database = drizzle("postgres://fixture")

const relation = database.select({ id: totals.id }).from(totals).as(getViewName(totals))

const imported = database.select({ id: ledgerTotals.id }).from(ledgerTotals).as(getViewName(ledgerTotals))

export const joined = database
	.select({ id: accounts.id })
	.from(accounts)
	.innerJoin(relation, eq(accounts.id, relation.id))
	.leftJoin(imported, eq(accounts.id, imported.id))

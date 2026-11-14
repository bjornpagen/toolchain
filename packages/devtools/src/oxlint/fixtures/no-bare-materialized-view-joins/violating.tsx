import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgMaterializedView, pgTable } from "drizzle-orm/pg-core"
import { ledgerTotals } from "#fixture/views.ts"
import * as views from "#fixture/views.ts"

const accounts = pgTable("accounts", { id: integer().notNull() })

const ledger = pgTable("ledger", { account: integer().notNull() })

const totals = pgMaterializedView("totals", { id: integer().notNull() }).existing()

const copied = totals

const database = drizzle("postgres://fixture")

const subquery = database.select({ id: totals.id }).from(totals).as("totals")

const selection = database.select({ id: accounts.id }).from(accounts)

export const inner = selection.innerJoin(totals, eq(accounts.id, totals.id)) // violation

export const left = selection.leftJoin(totals, eq(accounts.id, totals.id)) // violation

export const throughCopy = selection.fullJoin(copied, eq(accounts.id, copied.id)) // violation

export const imported = selection.rightJoin(ledgerTotals, eq(accounts.id, ledgerTotals.id)) // violation

export const namespaced = selection.innerJoin(views.ledgerTotals, eq(accounts.id, views.ledgerTotals.id)) // violation

export const wrapped = selection.innerJoin(subquery, eq(accounts.id, subquery.id))

export const table = selection.innerJoin(ledger, eq(accounts.id, ledger.account))

export const otherExport = selection.innerJoin(views.ledgerRows, eq(accounts.id, views.ledgerRows.id))

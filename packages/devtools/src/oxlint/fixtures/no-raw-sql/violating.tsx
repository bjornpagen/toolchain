import { sql } from "drizzle-orm"
import * as drizzle from "drizzle-orm"
import { sql as query } from "drizzle-orm/sql"
import { integer, pgTable } from "drizzle-orm/pg-core"

const accounts = pgTable("accounts", { id: integer().notNull() })

export const cast = sql`${accounts.id}::text` // violation
export const arrayCast = sql`array[]::int[]` // violation
export const after = sql`CASE ${accounts.id} WHEN 1 THEN 'a' END::text` // violation
export const parameter = sql`$1::name` // violation
export const renamed = query`${accounts.id}::bigint` // violation
export const namespaced = drizzle.sql`${accounts.id}::text` // violation

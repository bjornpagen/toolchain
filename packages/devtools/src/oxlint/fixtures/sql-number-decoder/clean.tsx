import { sql } from "drizzle-orm"

const tagged = <T,>(strings: TemplateStringsArray): T | string => strings.join("")

export const decoded = sql<number>`count(*)`.mapWith(Number)

export const raw = sql<unknown>`count(*)`

export const other = tagged<number>`count(*)`

import { Pool } from "pg"
import { READER_TIMEOUT_MILLISECONDS } from "#fixture/limits.ts"

const PRINCIPALS = { reader: "reader", writer: "writer" } as const

declare const username: string

export const pool = new Pool({
	statement_timeout: username === PRINCIPALS.reader ? READER_TIMEOUT_MILLISECONDS : false,
	idleTimeoutMillis: 1000
})

declare const settings: Readonly<Record<string, number>>

export const { statement_timeout: read } = settings

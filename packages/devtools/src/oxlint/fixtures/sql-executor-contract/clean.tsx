import type { SQL } from "drizzle-orm"
import type { Effect } from "effect"

type Statement = Readonly<{ text: string }>

export type Render = (statement: SQL) => string

export type Run = (statement: Statement) => Promise<unknown>

export interface Loader {
	load(id: number): Effect.Effect<unknown>
}

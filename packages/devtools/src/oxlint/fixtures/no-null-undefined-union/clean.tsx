import type { ReactNode } from "react"
import type { Maybe } from "#fixture/maybe.ts"

type Nullable<T> = T | null

export type Profile = {
	email?: string
	phone: string | null
	children: ReactNode
	nickname: Nullable<string>
	imported?: Maybe<string>
}

export interface Account {
	owner: string | null
	load(id: string): string | undefined
}

export class Session {
	token: string | null = null
	user?: string
}

export const greet = (name: string | undefined): string => String(name)

export const pick = (flag: boolean): string | null => (flag ? "yes" : null)

export const local = (): number => {
	const loose: string | null | undefined = undefined
	return loose === undefined ? 0 : 1
}

export const named = (label: "null" | "undefined"): string => label

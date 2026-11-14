import type { ReactNode } from "react"

type Maybe<T> = T | null

type Absent = undefined

export type Profile = {
	email?: string | null // violation
	phone: string | null | undefined // violation
	nickname?: Maybe<string> // violation
	slot: ReactNode | null | undefined // violation
	alias: Maybe<string> | Absent // violation
}

export interface Account {
	owner?: null | string // violation
	load(id: string): string | null | undefined // violation
}

export class Session {
	token: string | null | undefined = undefined // violation
	user?: string | null // violation
}

export const greet = (name: string | null | undefined): string => String(name) // violation

export const defaulted = (limit: number | null = 3): string => String(limit) // violation

export function optional(note?: string | null): string { // violation
	return String(note)
}

export const lookup = (id: string): string | null | undefined => (id === "" ? null : undefined) // violation

export type Handler = (event: Event | null | undefined) => void // violation

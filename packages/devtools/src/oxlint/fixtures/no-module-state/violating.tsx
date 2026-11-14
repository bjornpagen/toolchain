let counter = 0 // violation

var legacy = 1 // violation

export let exported = 0 // violation

const cache = new Map<string, number>() // violation

const seen = new Set<string>() // violation

const pending: Array<string> = [] // violation

const written: string[] = [] // violation

const pair: [number, number] = [0, 0] // violation

const totals: Record<string, number> = {} // violation

const box = { value: 0 } // violation

const copied = { ...box } // violation

const chosen = { value: 0 } satisfies Readonly<{ value: number }> // violation

const ticks = { count: 0 } as { count: number } | undefined // violation

const global = /x/g // violation

type Tally = { total: number }

const tally: Tally = { total: 0 } // violation

interface Slots {
	readonly first: number
	second: number
}

const slots: Slots = { first: 0, second: 0 } // violation

export const touch = (): number => {
	globalThis.undeclaredSlot = counter // violation
	globalThis["other"] += 1 // violation
	delete globalThis.undeclaredSlot // violation
	return legacy + cache.size + seen.size + pending.length + pair[0] + box.value
}

export const reflect = (): void => {
	Object.assign(globalThis, { other: 1 }) // violation
	Reflect.set(globalThis, "other", 2) // violation
}

export const exposed = [written, totals, copied, chosen, ticks, global, tally, slots] as const

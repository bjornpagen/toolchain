import { derived, measured as measuredLimit, published } from "@bjornpagen/limit"
import * as Limit from "@bjornpagen/limit"
import type { AnyLimit } from "@bjornpagen/limit"
declare const fields: Parameters<typeof published>[0]
declare const record: Parameters<typeof measuredLimit>[0]
declare const arithmetic: Parameters<typeof derived>[0]
declare const debt: Parameters<typeof Limit.provisional>[0]
declare const source: AnyLimit
export { provisional } from "@bjornpagen/limit" // violation
export * from "@bjornpagen/limit" // violation
export const quota = published(fields) // violation
export const point = measuredLimit(record) // violation
export const sum = derived(arithmetic) // violation
export const owed = Limit.provisional(debt) // violation
export const read = source.value

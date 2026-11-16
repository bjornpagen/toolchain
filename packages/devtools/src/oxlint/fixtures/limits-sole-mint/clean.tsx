import type { Limit } from "@bjornpagen/limit"
import { published } from "#fixture/press.ts"
import { pollTimeout } from "#fixture/limits.ts"
declare const quota: Limit
export type { Limit, AnyLimit } from "@bjornpagen/limit"
export const value = quota.value
export const article = published("today")
export const timeout = pollTimeout.value

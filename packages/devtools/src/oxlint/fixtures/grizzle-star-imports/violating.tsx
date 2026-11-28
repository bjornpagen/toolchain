import { relation } from "@bjornpagen/grizzle" // violation
import type { CallError } from "@bjornpagen/grizzle/client" // violation
import * as runtime from "@bjornpagen/grizzle/runtime" // violation
import compile from "@bjornpagen/grizzle/compile" // violation
import "@bjornpagen/grizzle/http" // violation

export const Notes = relation("notes", {})
export const layer = runtime.DbLayer
export const compiled = compile
export type Failure = CallError
export { Db } from "@bjornpagen/grizzle/runtime" // violation
export type { Fact } from "@bjornpagen/grizzle" // violation
export * from "@bjornpagen/grizzle/dynamic" // violation
export * as gCompile from "@bjornpagen/grizzle/compile" // violation

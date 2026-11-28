import { Array as Arr } from "effect"
import * as g from "@bjornpagen/grizzle"
import type * as gClient from "@bjornpagen/grizzle/client"
import * as gRuntime from "@bjornpagen/grizzle/runtime"
import { ok } from "@bjornpagen/grizzle-text/base/result"

export const Notes = g.relation("notes", { id: g.int4, body: g.str.regex("[a-z]+") })
export const layer = gRuntime.DbLayer
export const results = Arr.map([1, 2], (n) => ok(n))
export type Failure = gClient.CallError

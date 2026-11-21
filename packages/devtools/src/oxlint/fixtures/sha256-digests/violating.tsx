import { createHash } from "node:crypto"
import { Digest } from "effect/crypto"

declare const sql: (strings: TemplateStringsArray, ...values: ReadonlyArray<string>) => string
declare const keyText: string
declare const bytes: Uint8Array
declare const headers: Readonly<Record<string, string>>

/** Timeback's Aurora print: a key's digest the replica computes, which the prune must compute the same. */
export const keyDigest = sql`decode(md5(${keyText}), 'hex')` // violation
export const qualified = "SELECT pg_catalog.md5(body) FROM docs" // violation
export const upper = `SELECT MD5(body) FROM docs` // violation
/** A storage provider's checksum header, `md5=<base64>` among Google Cloud Storage's hashes. */
export const goog = headers["x-goog-hash"]?.split(",").find((hash) => hash.startsWith("md5=")) // violation
export const contentHeader = headers["Content-MD5"] // violation
export const node = createHash("md5").update(bytes).digest("hex") // violation
export const effect = Digest.md5 // violation
export const computeMd5 = (text: string) => text // violation
export const MD5_WIDTH = 16 // violation
export type Algorithm = "sha256" | "MD5" // violation
export const command = ["md5sum", "--check"] // violation
class Hasher {
	#md5 = 0 // violation
	value = () => this.#md5 // violation
}
export const hasher = new Hasher()

declare const sql: (strings: TemplateStringsArray, ...values: ReadonlyArray<string>) => string
declare const body: string
declare const headers: Readonly<Record<string, string>>
declare const stored: string

/**
 * Vercel's ETag: the site answers a file's HEAD with the MD5 of its bytes, and a rerun compares the tag it holds with
 * the one answered, as text, computing no digest of its own.
 */
export const etag = headers["etag"]
export const unchanged = etag === stored
export const digest = sql`encode(sha256(convert_to(${body}, 'UTF8')), 'hex')`
export const cmd5 = "run the fifth command"
export const hmacmd5 = "HMACMD5 is no word of its own"
export const base = "SGVsbG8gd29ybGQmd5"

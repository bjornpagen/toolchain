import { regex } from "arkregex"

/** The launcher's list of hardened flags: its `hardened="..."` assignment. */
const HARDENED_LINE = regex('^hardened="(?<flags>[^"]*)"$', "m")

/** The hardened flags the launcher's script passes, as one space-separated string, or none when it states none. */
export const launcherFlagsOf = (script: string): string =>
	HARDENED_LINE.exec(script)?.groups.flags ?? ""

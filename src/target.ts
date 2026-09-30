/**
 * Parsing for the `--ssh` flag value.
 *
 * Accepted forms:
 *   user@host                 -> remote home directory
 *   user@host:/srv/app        -> absolute remote directory
 *   user@host:~/app           -> remote directory relative to the home dir
 *   user@host:2222:/srv/app   -> explicit port
 *   user@[2001:db8::1]:/srv   -> bracketed IPv6 literal
 */

export interface SshTarget {
	/** `user@host`, `user@host:2222`, ... as passed to ssh(1). */
	readonly host: string;
	/** Remote directory, exactly as written (may start with `~`). */
	readonly dir?: string;
}

/** Characters ssh(1) tolerates in a destination argument. */
const HOST_PATTERN = /^[A-Za-z0-9._@%+=:[\]-]+$/;

export class TargetParseError extends Error {}

/** Find the first `:` that is not inside a bracketed IPv6 literal. */
function splitHostPort(spec: string): { hostPart: string; rest: string } {
	let bracketDepth = 0;
	for (let i = 0; i < spec.length; i++) {
		const char = spec[i];
		if (char === "[") bracketDepth++;
		else if (char === "]") bracketDepth--;
		else if (char === ":" && bracketDepth === 0) {
			return { hostPart: spec.slice(0, i), rest: spec.slice(i + 1) };
		}
	}
	return { hostPart: spec, rest: "" };
}

export function parseSshTarget(spec: string): SshTarget {
	const trimmed = spec.trim();
	if (!trimmed) throw new TargetParseError("--ssh needs a destination, for example user@host");
	if (/\s/.test(trimmed)) throw new TargetParseError(`Invalid SSH destination (whitespace): ${spec}`);

	const { hostPart, rest } = splitHostPort(trimmed);

	if (!HOST_PATTERN.test(hostPart)) throw new TargetParseError(`Invalid SSH destination: ${spec}`);
	if (rest.includes("\n")) throw new TargetParseError(`Invalid remote directory: ${spec}`);

	// `host:2222` is a port, `host:/srv` is a directory, `host:2222:/srv` is both.
	if (/^\d{1,5}$/.test(rest)) return { host: `${hostPart}:${rest}` };

	const portWithDir = /^(\d{1,5}):(.*)$/.exec(rest);
	if (portWithDir) return { host: `${hostPart}:${portWithDir[1]}`, dir: portWithDir[2]! };

	return rest ? { host: hostPart, dir: rest } : { host: hostPart };
}

/** True when the flag value looks like an SSH destination rather than something else. */
export function isSshTargetSpec(spec: string): boolean {
	try {
		parseSshTarget(spec);
		return true;
	} catch {
		return false;
	}
}

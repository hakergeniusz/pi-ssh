/**
 * POSIX shell quoting for the command strings sent over SSH.
 *
 * `ssh host cmd arg` concatenates its arguments with spaces and lets the remote
 * login shell parse them, so every interpolated value has to be quoted here.
 * JSON.stringify (as the upstream example does) is not enough: double quotes
 * still expand `$`, backticks and backslashes.
 */

/** Quote a single value for safe interpolation into a remote POSIX shell command. */
export function shellQuote(value: string): string {
	if (value === "") return "''";
	// Fast path: only characters that need no quoting at all.
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Quote every argument and join them with spaces. */
export function shellJoin(values: readonly string[]): string {
	return values.map(shellQuote).join(" ");
}

/**
 * Split a user-supplied option string into argv entries.
 *
 * Understands single and double quotes and backslash escapes, which is enough
 * for `PI_SSH_OPTIONS="-p 2222 -i ~/.ssh/id_ed25519"`.
 */
export function splitOptionString(raw: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;

	for (let i = 0; i < raw.length; i++) {
		const char = raw[i] ?? "";
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else current += char;
			continue;
		}
		if (quote === '"') {
			if (char === "\\" && i + 1 < raw.length && ['"', "\\", "$", "`"].includes(raw[i + 1]!)) {
				current += raw[i + 1] ?? "";
				i++;
			} else if (char === '"') {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			started = true;
			continue;
		}
		if (char === "\\" && i + 1 < raw.length) {
			current += raw[i + 1] ?? "";
			i++;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0 || started) {
				out.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}

	if (quote) throw new Error("Unbalanced quote in SSH options");
	if (current.length > 0 || started) out.push(current);
	return out;
}

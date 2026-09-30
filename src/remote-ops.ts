/**
 * Remote implementations of pi's file and shell tool operations.
 *
 * pi resolves every tool path against the *local* working directory and then
 * hands an absolute path to these operations, so each one translates the path
 * with the mapper before touching the remote host.
 */

import nodePath from "node:path";
import {
	type BashOperations,
	createLocalBashOperations,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { PathMapper } from "./path-map.ts";
import { shellQuote } from "./shell.ts";
import type { SshSession } from "./session.ts";

export interface RemoteContext {
	readonly session: SshSession;
	readonly mapper: PathMapper;
	/** Local working directory pi resolved tool paths against. */
	readonly localCwd: string;
	/** Allow `local: <command>` inside the bash tool to run on this machine. */
	readonly allowLocalBash: boolean;
}

/** Prefix that routes a bash command to the local machine instead of the remote one. */
export const LOCAL_ESCAPE_PREFIX = "local:";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".avif": "image/avif",
};

/** Resolve a tool path argument against a working directory, like pi's own tools do. */
export function resolveToolPath(input: string | undefined, cwd: string): string {
	if (!input || input === ".") return cwd;
	if (nodePath.isAbsolute(input)) return nodePath.resolve(input);
	return nodePath.resolve(cwd, input);
}

export function createRemoteReadOps({ session, mapper }: RemoteContext): ReadOperations {
	const toRemote = (localPath: string) => shellQuote(mapper.toRemote(localPath));

	return {
		async readFile(localPath: string): Promise<Buffer> {
			const script = [
				`if [ ! -e ${toRemote(localPath)} ]; then echo ${shellQuote(`Path not found: ${localPath}`)} >&2; exit 1; fi`,
				`if [ -d ${toRemote(localPath)} ]; then echo ${shellQuote(`Not a file: ${localPath}`)} >&2; exit 1; fi`,
				`cat -- ${toRemote(localPath)}`,
			].join("; ");
			const result = await session.exec(script);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr.trim() || `Cannot read ${localPath} (exit ${result.exitCode})`);
			}
			return result.stdout;
		},

		async access(localPath: string): Promise<void> {
			const script = `test -r ${toRemote(localPath)} || { echo ${shellQuote(`Cannot read: ${localPath}`)} >&2; exit 1; }`;
			const result = await session.exec(script);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr.trim() || `Cannot access: ${localPath}`);
			}
		},

		async detectImageMimeType(localPath: string): Promise<string | null> {
			const guessed = IMAGE_MIME_BY_EXTENSION[nodePath.extname(localPath).toLowerCase()];
			if (!session.capabilities.file) return guessed ?? null;
			try {
				const mime = (
					await session.capture(`file -b --mime-type -- ${toRemote(localPath)}`, { timeout: 20 })
				).trim();
				return mime.startsWith("image/") ? mime : null;
			} catch {
				return guessed ?? null;
			}
		},
	};
}

export function createRemoteWriteOps({ session, mapper }: RemoteContext): WriteOperations {
	const toRemote = (localPath: string) => shellQuote(mapper.toRemote(localPath));

	return {
		async writeFile(localPath: string, content: string): Promise<void> {
			const remote = mapper.toRemote(localPath);
			const parent = shellQuote(nodePath.posix.dirname(remote));
			// Content travels over stdin, so it never hits a command line length limit.
			const exitCode = await session.run(`mkdir -p -- ${parent} && cat > ${toRemote(localPath)}`, {
				stdin: Buffer.from(content, "utf-8"),
			});
			if (exitCode !== 0) throw new Error(`Cannot write ${localPath} (remote exit ${exitCode})`);
		},

		async mkdir(dir: string): Promise<void> {
			const exitCode = await session.run(`mkdir -p -- ${shellQuote(mapper.toRemote(dir))}`);
			if (exitCode !== 0) throw new Error(`Cannot create directory ${dir} (remote exit ${exitCode})`);
		},
	};
}

export function createRemoteEditOps(context: RemoteContext): EditOperations {
	const read = createRemoteReadOps(context);
	const write = createRemoteWriteOps(context);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (localPath: string) => {
			const remote = shellQuote(context.mapper.toRemote(localPath));
			const script = `test -e ${remote} && test -r ${remote} && test -w ${remote} || { echo ${shellQuote(`Not editable: ${localPath}`)} >&2; exit 1; }`;
			const result = await context.session.exec(script);
			if (result.exitCode !== 0) {
				throw new Error(result.stderr.trim() || `Cannot edit: ${localPath}`);
			}
		},
	};
}

/** Split a bash command into its local-escape prefix, if any. */
export function splitLocalEscape(command: string): { local: true; command: string } | { local: false; command: string } {
	const match = /^\s*local:\s?([\s\S]*)$/.exec(command);
	if (!match) return { local: false, command };
	return { local: true, command: match[1] ?? "" };
}

export function createRemoteBashOps(context: RemoteContext): BashOperations {
	const localOps = createLocalBashOperations();

	return {
		exec(command, cwd, { onData, signal, timeout, env }) {
			const escape = context.allowLocalBash ? splitLocalEscape(command) : { local: false as const, command };
			const effectiveCommand = escape.local ? escape.command : command;
			const operations = escape.local ? localOps : undefined;

			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				if (operations) {
					// Fall back to pi's own local shell so the escape hatch behaves exactly
					// like a pi session without this extension.
					operations
						.exec(effectiveCommand, cwd, { onData: (data) => onData(data), signal, timeout, env })
						.then(resolve, reject);
					return;
				}

				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}

				const remoteCwd = context.mapper.toRemote(cwd);
				context.session
					.run(effectiveCommand, {
						cwd: remoteCwd,
						onData: (data) => onData(data),
						signal,
						timeout,
					})
					.then((exitCode) => resolve({ exitCode }))
					.catch((error: unknown) => {
						reject(decorateRemoteError(error, context));
					});
			});
		},
	};
}

function decorateRemoteError(error: unknown, context: RemoteContext): unknown {
	if (!(error instanceof Error)) return error;
	if (error.message === "aborted" || error.message.startsWith("timeout:")) return error;
	// Point the model at the right place when a path it used does not exist remotely.
	const missingRemote = context.mapper.remoteRoot;
	if (error.message.includes(missingRemote)) {
		return new Error(`${error.message} (remote working directory: ${missingRemote})`);
	}
	return error;
}

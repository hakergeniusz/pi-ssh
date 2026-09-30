/**
 * Local <-> remote path translation.
 *
 * pi resolves tool paths against the local working directory, so every path the
 * extension sees is a local absolute path. In SSH mode that local directory is
 * mapped onto the remote working directory, and everything else is passed to
 * the remote host unchanged (so the model can still address `/etc/hosts`).
 */

import nodePath from "node:path";

export interface PathMapper {
	/** Local working directory, without a trailing slash. */
	readonly localRoot: string;
	/** Absolute remote working directory, without a trailing slash. */
	readonly remoteRoot: string;
	/** Local path -> remote path. */
	toRemote(localPath: string): string;
	/** Remote path -> local path (used to label remote output). */
	toLocal(remotePath: string): string;
}

function normalizeRoot(dir: string): string {
	const posix = nodePath.posix.normalize(dir.replaceAll("\\", "/"));
	if (posix.length > 1 && posix.endsWith("/")) return posix.slice(0, -1);
	return posix;
}

function isUnder(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

export function createPathMapper(localCwd: string, remoteCwd: string): PathMapper {
	const localRoot = normalizeRoot(localCwd);
	const remoteRoot = normalizeRoot(remoteCwd);

	const translate = (input: string, from: string, to: string): string => {
		if (!input) return input;
		// Remote-home paths stay remote-home paths; nothing local can be inferred.
		if (input === "~" || input.startsWith("~/")) return input;
		const normalized = nodePath.posix.normalize(input.replaceAll("\\", "/"));
		if (!isUnder(from, normalized)) return input;
		const rest = normalized.slice(from.length);
		return to + rest;
	};

	return {
		localRoot,
		remoteRoot,
		toRemote: (localPath: string) => translate(localPath, localRoot, remoteRoot),
		toLocal: (remotePath: string) => translate(remotePath, remoteRoot, localRoot),
	};
}

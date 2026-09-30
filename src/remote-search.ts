/**
 * Remote `ls`, `grep` and `find`.
 *
 * pi's grep and find tools shell out to *local* ripgrep and fd, so the
 * `operations` seam is not enough for a remote host: these are standalone tool
 * definitions that run the search on the remote side and translate the results
 * back into the local path space the model already works in.
 */

import nodePath from "node:path";
import {
	DEFAULT_MAX_BYTES,
	defineTool,
	formatSize,
	truncateHead,
	type AgentToolResult,
	type ExtensionToolContext,
	type FindToolDetails,
	type GrepToolDetails,
	type LsToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PathMapper } from "./path-map.ts";
import { resolveToolPath, type RemoteContext } from "./remote-ops.ts";
import { shellQuote } from "./shell.ts";

const DEFAULT_LS_LIMIT = 500;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
/** Upper bound for a single remote search. */
const SEARCH_TIMEOUT_SECONDS = 120;

export function createRemoteLsTool(context: RemoteContext) {
	const parameters = Type.Object({
		path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
		limit: Type.Optional(
			Type.Number({ description: `Maximum number of entries to return (default: ${DEFAULT_LS_LIMIT})` }),
		),
	});

	return defineTool({
		name: "ls",
		label: "ls",
		description:
			"List directory contents on the remote host. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles.",
		promptSnippet: "List directory contents on the remote host",
		parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<LsToolDetails | undefined>> {
			const localDir = resolveToolPath(params.path, workingDir(ctx, context));
			const remoteDir = context.mapper.toRemote(localDir);
			const limit = params.limit ?? DEFAULT_LS_LIMIT;

			const script = [
				`if [ ! -e ${shellQuote(remoteDir)} ]; then echo ${shellQuote(`Path not found: ${localDir}`)} >&2; exit 1; fi`,
				`if [ ! -d ${shellQuote(remoteDir)} ]; then echo ${shellQuote(`Not a directory: ${localDir}`)} >&2; exit 1; fi`,
				`cd ${shellQuote(remoteDir)} && ls -A -p`,
			].join("; ");

			const raw = await context.session.capture(script, { signal, timeout: SEARCH_TIMEOUT_SECONDS });
			const entries = raw
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

			const limitReached = entries.length > limit;
			const selected = limitReached ? entries.slice(0, limit) : entries;
			if (selected.length === 0) {
				return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
			}

			const truncation = truncateHead(selected.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			const notices: string[] = [];
			if (limitReached) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
			if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);

			return {
				content: [{ type: "text", text: withNotices(truncation.content, notices) }],
				details: limitReached ? { entryLimitReached: limit } : undefined,
			};
		},
	});
}

export function createRemoteGrepTool(context: RemoteContext) {
	const parameters = Type.Object({
		pattern: Type.String({ description: "Pattern to search for (regular expression unless literal is set)" }),
		path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
		literal: Type.Optional(Type.Boolean({ description: "Treat the pattern as a fixed string" })),
		context: Type.Optional(Type.Number({ description: "Number of context lines around each match" })),
		limit: Type.Optional(
			Type.Number({ description: `Maximum number of matching lines to return (default: ${DEFAULT_GREP_LIMIT})` }),
		),
	});

	return defineTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern on the remote host. Returns matching lines with file paths and line numbers. Respects .gitignore when ripgrep is installed there; otherwise falls back to grep.",
		promptSnippet: "Search file contents for patterns on the remote host",
		parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<GrepToolDetails | undefined>> {
			const localSearch = resolveToolPath(params.path, workingDir(ctx, context));
			const remoteSearch = context.mapper.toRemote(localSearch);
			const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
			const kind = await classifyPath(context, remoteSearch, localSearch, signal);

			const searchInput = {
				pattern: params.pattern,
				glob: params.glob,
				ignoreCase: params.ignoreCase,
				literal: params.literal,
				contextLines: params.context,
				searchPath: remoteSearch,
			};

			let tool: "rg" | "grep" = context.session.capabilities.rg ? "rg" : "grep";
			let result = await runSearch(context, tool, buildSearchArgv(tool, searchInput), signal);
			if (tool === "rg" && result.exitCode === 127) {
				// The probe saw ripgrep but running it failed: fall back instead of failing the call.
				tool = "grep";
				result = await runSearch(context, tool, buildSearchArgv(tool, searchInput), signal);
			}

			if (result.exitCode !== 0 && result.exitCode !== 1) {
				throw new Error(result.stderr.trim() || `Remote ${tool} failed (exit ${result.exitCode})`);
			}

			const body = mapGrepOutput(result.stdout, {
				mapper: context.mapper,
				searchRoot: kind === "dir" ? remoteSearch : undefined,
			});
			return grepResult(body, limit);
		},
	});
}

export function createRemoteFindTool(context: RemoteContext) {
	const parameters = Type.Object({
		pattern: Type.String({
			description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
		}),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
		limit: Type.Optional(
			Type.Number({ description: `Maximum number of results (default: ${DEFAULT_FIND_LIMIT})` }),
		),
	});

	return defineTool({
		name: "find",
		label: "find",
		description:
			"Find files by glob pattern on the remote host. Returns matching file paths relative to the search directory. Uses fd when installed there, otherwise find.",
		promptSnippet: "Find files by glob pattern on the remote host",
		parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<FindToolDetails | undefined>> {
			const localSearch = resolveToolPath(params.path, workingDir(ctx, context));
			const remoteSearch = context.mapper.toRemote(localSearch);
			const limit = params.limit ?? DEFAULT_FIND_LIMIT;

			const kind = await classifyPath(context, remoteSearch, localSearch, signal);
			if (kind === "file") {
				// The search path is a single file: compare its basename to the pattern's last segment.
				const matches = matchesGlob(
					nodePath.posix.basename(localSearch),
					nodePath.posix.basename(params.pattern),
				);
				return {
					content: [{ type: "text", text: matches ? localSearch : "(no matches)" }],
					details: undefined,
				};
			}

			const raw = context.session.capabilities.fd
				? await runFd(context, params.pattern, remoteSearch, limit + 1, signal)
				: await runFindFallback(context, params.pattern, remoteSearch, limit + 1, signal);

			const entries = raw
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => normalizeFindPath(line, context.mapper))
				.filter((line, index, all) => all.indexOf(line) === index)
				.sort((a, b) => a.localeCompare(b));

			const limitReached = entries.length > limit;
			const selected = limitReached ? entries.slice(0, limit) : entries;
			if (selected.length === 0) {
				return { content: [{ type: "text", text: "(no matches)" }], details: undefined };
			}

			const truncation = truncateHead(selected.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			const notices: string[] = [];
			if (limitReached) notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more`);
			if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);

			return {
				content: [{ type: "text", text: withNotices(truncation.content, notices) }],
				details: limitReached ? { resultLimitReached: limit } : undefined,
			};
		},
	});
}

/* ------------------------------------------------------------------ helpers */

/** pi resolves relative tool paths against the session cwd, which is still local here. */
function workingDir(ctx: ExtensionToolContext | undefined, context: RemoteContext): string {
	return ctx?.cwd ?? context.localCwd;
}

function withNotices(body: string, notices: string[]): string {
	return notices.length > 0 ? `${body}\n\n[${notices.join(". ")}]` : body;
}

export interface SearchArgvInput {
	pattern: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	contextLines?: number;
	searchPath: string;
}

/**
 * Build the remote search command for the tool that actually exists on the host.
 *
 * ripgrep and grep disagree about nearly every flag, so each gets its own argv
 * rather than a half-shared one.
 */
export function buildSearchArgv(tool: "rg" | "grep", input: SearchArgvInput): string[] {
	const { pattern, glob, ignoreCase, literal, contextLines, searchPath } = input;
	if (searchPath.includes("\n")) throw new Error("Invalid search path");
	const contextCount = contextLines && contextLines > 0 ? Math.floor(contextLines) : 0;

	if (tool === "rg") {
		const argv = [
			"--line-number",
			"--color=never",
			"--no-heading",
			"--with-filename",
			"--hidden",
			"--no-messages",
		];
		if (ignoreCase) argv.push("--ignore-case");
		if (literal) argv.push("--fixed-strings");
		if (glob) argv.push("--glob", shellQuote(glob));
		if (contextCount > 0) argv.push("--context", String(contextCount));
		argv.push("-e", shellQuote(pattern), "--", shellQuote(searchPath));
		return argv;
	}

	const argv = ["-rn", "--binary-files=without-match", "--exclude-dir=.git"];
	if (ignoreCase) argv.push("-i");
	if (literal) argv.push("-F");
	if (glob) argv.push(`--include=${shellQuote(glob)}`);
	if (contextCount > 0) argv.push("-C", String(contextCount));
	argv.push("-e", shellQuote(pattern), "--", shellQuote(searchPath));
	return argv;
}

interface SearchResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

async function runSearch(
	context: RemoteContext,
	tool: "rg" | "grep",
	argv: string[],
	signal: AbortSignal | undefined,
): Promise<SearchResult> {
	const result = await context.session.exec(`${tool} ${argv.join(" ")}`, {
		signal,
		timeout: SEARCH_TIMEOUT_SECONDS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr };
}

async function classifyPath(
	context: RemoteContext,
	remotePath: string,
	localPath: string,
	signal: AbortSignal | undefined,
): Promise<"dir" | "file"> {
	const script = [
		`if [ -d ${shellQuote(remotePath)} ]; then echo dir`,
		`elif [ -e ${shellQuote(remotePath)} ]; then echo file`,
		`else echo ${shellQuote(`Path not found: ${localPath}`)} >&2; exit 1; fi`,
	].join("; ");
	const out = await context.session.capture(script, { signal, timeout: SEARCH_TIMEOUT_SECONDS });
	return out.trim() === "dir" ? "dir" : "file";
}

/** Rewrite `path:line:text` output from the remote path space into the local one. */
export function mapGrepOutput(output: string, { mapper, searchRoot }: { mapper: PathMapper; searchRoot?: string }): string {
	return output
		.split("\n")
		.map((line) => {
			// Match lines look like `path:12:text`, context lines like `path-12-text`.
			const match = /^(.*?[:-])(\d+)([:-])([\s\S]*)$/.exec(line);
			if (!match) return line;
			const rawPath = match[1]!.slice(0, -1);
			const mappedRoot = searchRoot ? mapper.toLocal(searchRoot) : undefined;
			let localPath = mapper.toLocal(rawPath);
			if (mappedRoot) {
				if (localPath === mappedRoot) localPath = ".";
				else if (localPath.startsWith(`${mappedRoot}/`)) localPath = localPath.slice(mappedRoot.length + 1);
			}
			return `${localPath}:${match[2]}:${match[4]}`;
		})
		.filter((line) => line.length > 0)
		.join("\n");
}

function grepResult(body: string, limit: number): AgentToolResult<GrepToolDetails | undefined> {
	if (body.trim() === "") {
		return { content: [{ type: "text", text: "(no matches)" }], details: undefined };
	}
	const lines = body.split("\n");
	const limitReached = lines.length > limit;
	const truncation = truncateHead((limitReached ? lines.slice(0, limit) : lines).join("\n"));
	const notices: string[] = [];
	if (limitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more`);
	if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	return {
		content: [{ type: "text", text: withNotices(truncation.content, notices) }],
		details: limitReached ? { matchLimitReached: limit } : undefined,
	};
}

async function runFd(
	context: RemoteContext,
	pattern: string,
	remoteSearch: string,
	maxResults: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	if (pattern.includes("\n")) throw new Error("Invalid find pattern");

	const attempt = (extraFlag: string) =>
		context.session.exec(
			`fd --glob --type f --max-results ${maxResults} ${extraFlag} -- ${shellQuote(pattern)} .`,
			{ cwd: remoteSearch, signal, timeout: SEARCH_TIMEOUT_SECONDS },
		);

	let result = await attempt("--no-require-git");
	if (result.exitCode !== 0 && result.exitCode !== 1) {
		// Older fd releases do not know --no-require-git; retry without it.
		result = await attempt("");
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			throw new Error(result.stderr.trim() || `Remote fd failed (exit ${result.exitCode})`);
		}
	}
	return result.stdout.toString();
}

async function runFindFallback(
	context: RemoteContext,
	pattern: string,
	remoteSearch: string,
	maxResults: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const script = [
		`cd ${shellQuote(remoteSearch)} || exit 1`,
		`find . -type f ${findPredicate(pattern)} -not -path '*/.git/*' | head -n ${maxResults}`,
	].join("; ");
	return context.session.capture(script, { signal, timeout: SEARCH_TIMEOUT_SECONDS });
}

/**
 * Translate a glob into a `find` predicate. `find` has no `**`, and `-name`
 * only matches the basename, so path-like patterns become `-path`.
 */
export function findPredicate(pattern: string): string {
	if (pattern.includes("/")) {
		const normalized = pattern.replaceAll("**/", "*/").replace(/^\.\//, "");
		return `-path ${shellQuote(`./${normalized}`)}`;
	}
	return `-name ${shellQuote(pattern)}`;
}

/** Small glob matcher (`*` and `**` only) used when the search path is one file. */
export function matchesGlob(name: string, pattern: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", "\u0000")
		.replaceAll("*", "[^/]*")
		.replaceAll("\u0000", ".*");
	return new RegExp(`^${escaped}$`).test(name);
}

function normalizeFindPath(line: string, mapper: PathMapper): string {
	const relative = line.startsWith("./") ? line.slice(2) : line;
	return nodePath.isAbsolute(relative) ? mapper.toLocal(relative) : relative;
}

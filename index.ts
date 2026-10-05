/**
 * pi-ssh — work on a remote machine from pi.
 *
 *   pi --ssh user@host
 *   pi --ssh user@host:/srv/app
 *
 * With the flag set, `read`, `write`, `edit`, `bash`, `ls`, `grep` and `find`
 * all execute on the remote host, and the local working directory is mapped
 * onto the remote one so the model keeps using familiar local paths. Without
 * the flag every tool behaves exactly like stock pi, and `/ssh on` can connect
 * mid-session. The `ls`/`grep`/`find` tools are declared to the model only
 * while a session is connected, so idle sessions cost no extra tokens.
 *
 * Inspired by the upstream `examples/extensions/ssh.ts`, extended with remote
 * search tools, connection multiplexing, POSIX-correct quoting and a `/ssh`
 * command for inspecting and toggling the link.
 */

import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createPathMapper, type PathMapper } from "./src/path-map.ts";
import { renderTailWriteCall, tailPreviewEnabled } from "./src/tail-write.ts";
import {
	createRemoteBashOps,
	createRemoteEditOps,
	createRemoteReadOps,
	createRemoteWriteOps,
	LOCAL_ESCAPE_PREFIX,
	type RemoteContext,
} from "./src/remote-ops.ts";
import { createRemoteFindTool, createRemoteGrepTool, createRemoteLsTool } from "./src/remote-search.ts";
import { SshSession } from "./src/session.ts";
import { parseSshTarget } from "./src/target.ts";

const STATUS_KEY = "ssh";
/** How much output `/ssh run` pastes into a notification. */
const MAX_NOTIFY_OUTPUT = 2000;

/** The tool shape this extension routes: only `execute` is ever replaced. */
type AnyTool = ToolDefinition<any, any, any>;

interface SshState {
	session: SshSession | null;
	mapper: PathMapper | null;
	localCwd: string;
	allowLocalBash: boolean;
	lastSpec: string | undefined;
	error: string | undefined;
}

export default function piSsh(pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const state: SshState = {
		session: null,
		mapper: null,
		localCwd,
		allowLocalBash: false,
		lastSpec: undefined,
		error: undefined,
	};

	pi.registerFlag("ssh", {
		description: "Run every tool on a remote machine: user@host, or user@host:/remote/dir",
		type: "string",
	});
	pi.registerFlag("ssh-allow-local", {
		description: "Allow the bash tool to escape to this machine with a `local: ` prefix",
		type: "boolean",
		default: false,
	});

	const localTools = {
		read: createReadTool(localCwd),
		write: createWriteTool(localCwd),
		edit: createEditTool(localCwd),
		bash: createBashTool(localCwd),
		ls: createLsTool(localCwd),
		grep: createGrepTool(localCwd),
		find: createFindTool(localCwd),
	};

	/** Remote tool instances for the active session (pi's operations-based tools). */
	let remoteTools: Record<string, AnyTool> | undefined;
	let remoteToolsSession: SshSession | null = null;

	function remoteContext(session = state.session, mapper = state.mapper): RemoteContext | null {
		if (!session || !mapper) return null;
		return { session, mapper, localCwd: state.localCwd, allowLocalBash: state.allowLocalBash };
	}

	function remoteToolSet(session: SshSession): Record<string, AnyTool> {
		if (remoteTools && remoteToolsSession === session) return remoteTools;
		const context = remoteContext(session);
		if (!context) throw new Error("SSH session is not connected");
		remoteTools = {
			read: createReadTool(localCwd, { operations: createRemoteReadOps(context) }),
			write: createWriteTool(localCwd, { operations: createRemoteWriteOps(context) }),
			edit: createEditTool(localCwd, { operations: createRemoteEditOps(context) }),
			bash: createBashTool(localCwd, { operations: createRemoteBashOps(context) }),
			ls: createRemoteLsTool(context),
			grep: createRemoteGrepTool(context),
			find: createRemoteFindTool(context),
		} as unknown as Record<string, AnyTool>;
		remoteToolsSession = session;
		return remoteTools;
	}

	/** Delegate to the remote tool when connected, otherwise to stock pi's. */
	function route(name: keyof typeof localTools): AnyTool {
		const local = localTools[name] as unknown as AnyTool;
		// write previews the tail of the file being written: while a long file
		// streams, the head-first preview shows lines that arrived long ago.
		const renderCall =
			name === "write" && tailPreviewEnabled()
				? (args: any, theme: any, context: any) => renderTailWriteCall(args, theme, context)
				: local.renderCall;
		return {
			...local,
			renderCall,
			execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
				if (!state.session) return local.execute(toolCallId, params, signal, onUpdate, ctx);
				const tools = remoteToolSet(state.session);
				return tools[name]!.execute(toolCallId, params, signal, onUpdate, ctx);
			},
		} as AnyTool;
	}

	// read/write/edit/bash replace the built-ins 1:1: same declarations, with
	// execute() routed to the remote host when connected and falling back to
	// local when not. They must stay declared in every session.
	for (const name of ["read", "write", "edit", "bash"] as const) {
		pi.registerTool(route(name));
	}

	/**
	 * ls/grep/find only exist to run on the remote host (locally the bash tool
	 * covers them), so they are declared only while an SSH session is active.
	 * Tools cannot be unregistered; re-registering with `exposure: "hidden"`
	 * withdraws the declaration, and re-registering plainly activates it again
	 * (pi records the change as one tool delta before the next request).
	 */
	let searchToolsVisible: boolean | null = null;
	function setSearchTools(visible: boolean): void {
		if (visible === searchToolsVisible) return;
		searchToolsVisible = visible;
		for (const name of ["ls", "grep", "find"] as const) {
			const tool = route(name);
			pi.registerTool(visible ? tool : { ...tool, exposure: "hidden" });
		}
	}
	setSearchTools(false);

	function statusText(): string | undefined {
		if (!state.session || !state.mapper) return undefined;
		return `ssh ${state.session.host}:${state.session.cwd}`;
	}

	function refreshStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const text = statusText();
		if (!text) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		// The theme is a TUI luxury; RPC/headless UIs may not provide one.
		let styled = text;
		try {
			styled = ctx.ui.theme?.fg("accent", text) ?? text;
		} catch {
			/* keep plain text */
		}
		ctx.ui.setStatus(STATUS_KEY, styled);
	}

	function setSession(session: SshSession | null, mapper: PathMapper | null, spec?: string): void {
		state.session?.close();
		state.session = session;
		state.mapper = mapper;
		state.error = undefined;
		if (spec) state.lastSpec = spec;
		remoteTools = undefined;
		remoteToolsSession = null;
		setSearchTools(session !== null);
	}

	async function connect(spec: string, ctx: ExtensionContext): Promise<boolean> {
		try {
			const target = parseSshTarget(spec);
			const session = await SshSession.open({ host: target.host, dir: target.dir });
			const mapper = createPathMapper(state.localCwd, session.cwd);
			setSession(session, mapper, spec);
			refreshStatus(ctx);
			ctx.ui.notify(`SSH mode: ${session.describe()}`, "info");
			if (!session.capabilities.rg || !session.capabilities.fd) {
				ctx.ui.notify(
					`Remote host is missing ${[!session.capabilities.rg ? "rg" : null, !session.capabilities.fd ? "fd" : null]
						.filter(Boolean)
						.join(" and ")}; grep/find fall back to slower tools.`,
					"warning",
				);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setSession(null, null);
			state.error = message;
			refreshStatus(ctx);
			ctx.ui.notify(`SSH mode off: ${message}`, "error");
			return false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		state.allowLocalBash = pi.getFlag("ssh-allow-local") === true;
		const spec = pi.getFlag("ssh");
		if (typeof spec === "string" && spec.trim()) {
			await connect(spec.trim(), ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		refreshStatus(ctx);
		setSession(null, null);
	});

	/** `!command` typed by the user also runs on the remote host. */
	pi.on("user_bash", () => {
		const context = remoteContext();
		if (!context) return;
		return { operations: createRemoteBashOps(context) };
	});

	/** Tell the model where it actually is, without replacing the whole prompt. */
	pi.on("before_agent_start", (event) => {
		const context = remoteContext();
		if (!context) return;

		const { session, localCwd, allowLocalBash } = context;
		const options = event.systemPromptOptions;
		options.cwd = session.cwd;
		options.promptGuidelines.push(
			`You are working on the remote machine ${session.host}: every tool call (read, write, edit, bash, ls, grep, find) executes there, not on the local machine.`,
		);
		options.sections = {
			...options.sections,
			ssh: [
				`Remote session: ${session.host} (${session.uname})`,
				`Working directory: ${session.cwd}`,
				`The local directory ${localCwd} is mapped onto the remote working directory, so paths under it are translated for you. Absolute paths outside it (for example /etc/hosts) are used on the remote host as-is.`,
				`File contents, command output and search results all come from ${session.host}. Paths shown by ls, grep and find are local paths, ready to be passed to another tool.`,
				allowLocalBash
					? `To run a command on the local machine instead, prefix it with "${LOCAL_ESCAPE_PREFIX} ".`
					: "There is no local escape hatch: everything runs on the remote host.",
			].join("\n"),
		};
	});

	pi.registerCommand("ssh", {
		description: "Inspect or control the SSH link (status | run <cmd> | local <cmd> | on [target] | off)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);
			const payload = rest.join(" ").trim();
			state.allowLocalBash = state.allowLocalBash || pi.getFlag("ssh-allow-local") === true;

			switch ((subcommand ?? "").toLowerCase()) {
				case "off": {
					setSession(null, null);
					refreshStatus(ctx);
					ctx.ui.notify("SSH mode off; tools run locally again", "info");
					return;
				}
				case "on": {
					const spec = payload || state.lastSpec;
					if (!spec) {
						ctx.ui.notify("Usage: /ssh on user@host[:/remote/dir]", "error");
						return;
					}
					await connect(spec, ctx);
					return;
				}
				case "run": {
					if (!payload) {
						ctx.ui.notify("Usage: /ssh run <command>", "error");
						return;
					}
					const session = state.session;
					if (!session) {
						ctx.ui.notify("Not connected. Use /ssh on user@host first.", "error");
						return;
					}
					try {
						const output = await session.capture(payload, { timeout: 120 });
						ctx.ui.notify(output.trim() ? clip(output) : "(no output)", "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				case "local": {
					if (!payload) {
						ctx.ui.notify("Usage: /ssh local <command>", "error");
						return;
					}
					try {
						const { exitCode, output } = await runLocal(payload);
						ctx.ui.notify(
							`exit ${exitCode ?? "null"}\n${output.trim() ? clip(output) : "(no output)"}`,
							exitCode === 0 ? "info" : "warning",
						);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				case "status":
				case "":
					ctx.ui.notify(describeSession(), "info");
					return;
				default:
					ctx.ui.notify(
						`Unknown subcommand "${subcommand}". Try: /ssh, /ssh run, /ssh local, /ssh on, /ssh off`,
						"error",
					);
			}
		},
	});

	function describeSession(): string {
		if (!state.session || !state.mapper) {
			const reason = state.error ? ` (last error: ${state.error})` : "";
			return `SSH mode off${reason}\nLocal working directory: ${state.localCwd}\nConnect with: pi --ssh user@host:/remote/dir`;
		}
		const { session, mapper } = state;
		const { rg, fd, file } = session.capabilities;
		return [
			`SSH mode on: ${session.describe()}`,
			`Local ${mapper.localRoot} -> remote ${mapper.remoteRoot}`,
			`Remote tools: rg ${yesNo(rg)}, fd ${yesNo(fd)}, file ${yesNo(file)}`,
			`Local escape hatch: ${state.allowLocalBash ? `enabled ("${LOCAL_ESCAPE_PREFIX} <command>")` : "disabled (--ssh-allow-local)"}`,
		].join("\n");
	}

	async function runLocal(command: string): Promise<{ exitCode: number | null; output: string }> {
		let output = "";
		const operations: BashOperations = createLocalBashOperations();
		const { exitCode } = await operations.exec(command, state.localCwd, {
			onData: (data) => {
				output += data.toString();
			},
			timeout: 120,
		});
		return { exitCode, output };
	}
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

function clip(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= MAX_NOTIFY_OUTPUT
		? trimmed
		: `${trimmed.slice(0, MAX_NOTIFY_OUTPUT)}\n… (${trimmed.length - MAX_NOTIFY_OUTPUT} more characters)`;
}

/**
 * The SSH transport: one multiplexed connection to a remote host, plus the
 * capability probe used to decide how `grep`, `find` and image detection are
 * executed there.
 *
 * Connection reuse matters more than it looks: a typical agent turn makes dozens
 * of small calls, and a fresh TCP + auth handshake per call dominates the
 * latency. `ControlMaster=auto` therefore turns the first call into the master
 * connection and every later call reuses it until `ControlPersist` expires.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, splitOptionString } from "./shell.ts";

/** Seconds ssh waits for the TCP/handshake phase before giving up. */
const CONNECT_TIMEOUT_SECONDS = 15;
/** How long the background master connection lingers after the last call. */
const CONTROL_PERSIST_SECONDS = 300;
/** Tail of remote stderr kept for error messages. */
const STDERR_TAIL_BYTES = 4000;

export type SshDataStream = "stdout" | "stderr";

export interface SshSessionOptions {
	/** Destination passed to ssh(1), e.g. `user@host` or `user@host:2222`. */
	readonly host: string;
	/** Remote directory to start in. Defaults to the remote home directory. */
	readonly dir?: string;
	/** Extra `ssh` arguments, e.g. from `PI_SSH_OPTIONS`. */
	readonly extraOptions?: readonly string[];
	/** Directory holding the control socket. Created on demand. */
	readonly controlDir?: string;
}

export interface RemoteResult {
	readonly exitCode: number | null;
	readonly stdout: Buffer;
	readonly stderr: string;
}

export interface RunOptions {
	/** Directory to run in, on the remote host. Defaults to the session cwd. */
	readonly cwd?: string;
	readonly signal?: AbortSignal;
	/** Seconds before the local ssh process is killed. */
	readonly timeout?: number;
	/** Receives stdout and stderr as they arrive. */
	readonly onData?: (data: Buffer, stream: SshDataStream) => void;
	/** Data written to the remote command's stdin. */
	readonly stdin?: string | Buffer;
}

export interface RemoteCapabilities {
	/** ripgrep is available remotely (fast, gitignore-aware grep). */
	readonly rg: boolean;
	/** fd is available remotely (fast, gitignore-aware find). */
	readonly fd: boolean;
	/** file(1) is available remotely (image MIME detection). */
	readonly file: boolean;
}

export class SshError extends Error {
	constructor(
		message: string,
		readonly stderr = "",
		readonly exitCode: number | null = null,
	) {
		super(message);
		this.name = "SshError";
	}
}

export class SshSession {
	readonly host: string;
	readonly cwd: string;
	readonly uname: string;
	readonly capabilities: RemoteCapabilities;

	private readonly extraOptions: readonly string[];

	private constructor(
		options: SshSessionOptions,
		cwd: string,
		uname: string,
		capabilities: RemoteCapabilities,
		private readonly controlDir: string | undefined,
		extraOptions: readonly string[],
	) {
		this.host = options.host;
		this.cwd = cwd;
		this.uname = uname;
		this.capabilities = capabilities;
		this.extraOptions = extraOptions;
	}

	/** Connect, resolve the remote working directory, and probe remote tooling. */
	static async open(options: SshSessionOptions, signal?: AbortSignal): Promise<SshSession> {
		const extraOptions = options.extraOptions ?? splitOptionString(process.env.PI_SSH_OPTIONS ?? "");
		const controlDir = options.controlDir ?? createControlDir(options.host);
		const probe = new SshSession(options, options.dir ?? "~", "", EMPTY_CAPABILITIES, controlDir, extraOptions);

		const script = [
			`cd ${shellQuote(options.dir ?? "~")} || exit 70`,
			"pwd -P",
			"uname -sr 2>/dev/null || echo unknown",
			'for tool in rg fd file; do command -v "$tool" >/dev/null 2>&1 && echo "pi-ssh-tool:$tool"; done',
		].join("; ");

		let probeResult: RemoteResult;
		try {
			probeResult = await probe.exec(script, { timeout: CONNECT_TIMEOUT_SECONDS, signal });
		} catch (error) {
			// spawnRemote rejects for transport failures (exit 255, spawn errors, aborts).
			probe.close();
			const detail = error instanceof Error ? error.message : String(error);
			throw new SshError(`Cannot connect to ${options.host}: ${detail}`);
		}
		const result = probeResult;
		if (result.exitCode !== 0) {
			const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
			if (result.exitCode === 70) {
				probe.close();
				throw new SshError(
					`Remote directory not usable on ${options.host}: ${options.dir ?? "~"} (${detail})`,
					result.stderr,
					result.exitCode,
				);
			}
			probe.close();
			throw new SshError(`Cannot connect to ${options.host}: ${detail}`, result.stderr, result.exitCode);
		}

		const lines = result.stdout
			.toString()
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

		const cwd = lines[0];
		if (!cwd || !cwd.startsWith("/")) {
			probe.close();
			throw new SshError(`Unexpected working directory from ${options.host}: ${cwd ?? "(none)"}`);
		}

		const tools = new Set(
			lines.filter((line) => line.startsWith(TOOL_MARKER)).map((line) => line.slice(TOOL_MARKER.length)),
		);

		return new SshSession(
			options,
			cwd,
			lines[1] ?? "unknown",
			{ rg: tools.has("rg"), fd: tools.has("fd"), file: tools.has("file") },
			controlDir,
			extraOptions,
		);
	}

	/** Run a command, capturing stdout and stderr. Never rejects on a non-zero exit. */
	async exec(command: string, options: Omit<RunOptions, "onData"> = {}): Promise<RemoteResult> {
		const stdout: Buffer[] = [];
		const stderr: string[] = [];
		const exitCode = await this.spawnRemote(command, {
			...options,
			onData: (data, stream) => {
				if (stream === "stdout") stdout.push(data);
				else stderr.push(data.toString());
			},
		});
		return { exitCode, stdout: Buffer.concat(stdout), stderr: stderr.join("") };
	}

	/** Run a command in `cwd`, streaming output. Rejects on abort, timeout or spawn failure. */
	run(command: string, options: RunOptions = {}): Promise<number | null> {
		return this.spawnRemote(command, options);
	}

	/** Run `script` in `cwd` and return trimmed stdout, throwing on a non-zero exit. */
	async capture(script: string, options: Omit<RunOptions, "onData" | "stdin"> = {}): Promise<string> {
		const result = await this.exec(script, options);
		if (result.exitCode !== 0) {
			throw new SshError(
				result.stderr.trim() || `Remote command failed (exit ${result.exitCode})`,
				result.stderr,
				result.exitCode,
			);
		}
		return result.stdout.toString();
	}

	/** One-line description for status output. */
	describe(): string {
		const tools = Object.entries(this.capabilities)
			.filter(([, available]) => available)
			.map(([name]) => name);
		const suffix = tools.length > 0 ? ` [${tools.join(", ")}]` : " [no rg/fd/file]";
		return `${this.host} ${this.cwd} (${this.uname})${suffix}`;
	}

	private sshArgs(remoteCommand: string): string[] {
		const args = ["-T"];
		if (this.controlDir) {
			args.push(
				"-o",
				"ControlMaster=auto",
				"-o",
				`ControlPath=${this.controlDir}/cm`,
				"-o",
				`ControlPersist=${CONTROL_PERSIST_SECONDS}`,
			);
		}
		args.push(
			"-o",
			"BatchMode=yes",
			"-o",
			`ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=3",
			"-o",
			"LogLevel=ERROR",
		);
		return [...args, ...this.extraOptions, this.host, remoteCommand];
	}

	private spawnRemote(command: string, { cwd = this.cwd, signal, timeout, onData, stdin }: RunOptions): Promise<number | null> {
		return new Promise<number | null>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}

			// `cd` in front of the command keeps the remote shell's cwd semantics identical to
			// a local bash tool call, including relative paths used inside the command itself.
			// `echo $$` publishes the remote shell's pid as the first stdout line (stripped
			// below before anyone sees it): sshd runs each session in its own process group,
			// so an aborted command can be killed remotely with `kill -- -pid`. The closing
			// brace sits on its own line so commands ending in `&` stay valid.
			const remoteCommand = `cd ${shellQuote(cwd)} && { echo $$; ${command}\n}`;
			const child: ChildProcessWithoutNullStreams = spawn("ssh", this.sshArgs(remoteCommand), {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let settled = false;
			let timedOut = false;
			let terminated = false;
			let stderrTail = "";
			/** Remote shell pid: null while the first line has not arrived, -1 when unavailable. */
			let remotePid: number | null = null;
			let pidScan = Buffer.alloc(0);
			const timers = new Set<NodeJS.Timeout>();

			const cleanup = () => {
				for (const timer of timers) clearTimeout(timer);
				timers.clear();
				signal?.removeEventListener("abort", onAbort);
			};
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};

			/** Signal the remote command's whole process group. Fire and forget; the
			 * multiplexed control socket makes the extra connection nearly free. */
			const killRemote = (sig: "TERM" | "KILL") => {
				if (remotePid === null || remotePid <= 0) return;
				const killer = spawn(
					"ssh",
					this.sshArgs(`kill -${sig} -- -${remotePid} ${remotePid} 2>/dev/null || :`),
					{ stdio: "ignore" },
				);
				killer.on("error", () => {});
				killer.unref?.();
			};

			const terminate = () => {
				if (terminated) return;
				terminated = true;
				child.kill("SIGTERM");
				killRemote("TERM");
				// Escalate unconditionally: child.killed is set by any kill() call,
				// even one the process has not acted on yet.
				const killTimer = setTimeout(() => {
					child.kill("SIGKILL");
					killRemote("KILL");
				}, 2000);
				killTimer.unref?.();
				timers.add(killTimer);
				// The background control master inherits our stdio pipes; without
				// destroying them `close` waits for the master (i.e. until the remote
				// command ends naturally) instead of the kill.
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
			};
			function onAbort() {
				terminate();
			}

			// Swallow the published pid line; forward everything after it untouched.
			const handleStdout = (data: Buffer) => {
				if (remotePid !== null) {
					onData?.(data, "stdout");
					return;
				}
				pidScan = Buffer.concat([pidScan, data]);
				const newline = pidScan.indexOf(0x0a);
				if (newline === -1) {
					if (pidScan.length > 64) {
						remotePid = -1;
						onData?.(pidScan, "stdout");
					}
					return;
				}
				const line = pidScan.subarray(0, newline).toString("utf-8").trim();
				remotePid = /^\d{1,16}$/.test(line) ? Number.parseInt(line, 10) : -1;
				const rest = pidScan.subarray(newline + 1);
				if (rest.length > 0) onData?.(rest, "stdout");
			};

			child.stdout.on("data", handleStdout);
			child.stderr.on("data", (data: Buffer) => {
				if (stderrTail.length < STDERR_TAIL_BYTES) stderrTail += data.toString();
				onData?.(data, "stderr");
			});

			if (stdin !== undefined) {
				// The remote command may exit before reading stdin; EPIPE is expected then.
				child.stdin.on("error", () => {});
				child.stdin.end(stdin);
			} else {
				child.stdin.end();
			}

			if (timeout && timeout > 0) {
				const timer = setTimeout(() => {
					timedOut = true;
					terminate();
				}, timeout * 1000);
				timer.unref?.();
				timers.add(timer);
			}

			signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					settle(() => reject(new SshError("ssh executable not found on this machine")));
					return;
				}
				settle(() => reject(error));
			});

			child.on("close", (code) => {
				if (signal?.aborted) {
					settle(() => reject(new Error("aborted")));
					return;
				}
				if (timedOut) {
					settle(() => reject(new Error(`timeout:${timeout}`)));
					return;
				}
				// 255 is ssh's own failure code (auth, network, bad destination).
				if (code === 255) {
					settle(() => reject(new SshError(describeTransportFailure(stderrTail, code), stderrTail, code)));
					return;
				}
				settle(() => resolve(code));
			});
		});
	}

	/** Best-effort teardown: drop the shared control socket and remove its directory. */
	close(): void {
		if (!this.controlDir) return;
		try {
			spawn("ssh", ["-O", "exit", "-o", `ControlPath=${this.controlDir}/cm`, this.host], { stdio: "ignore" }).unref();
		} catch {
			// The socket disappears with the directory below.
		}
		try {
			rmSync(this.controlDir, { recursive: true, force: true });
		} catch {
			// Best effort only.
		}
	}
}

const TOOL_MARKER = "pi-ssh-tool:";
const EMPTY_CAPABILITIES: RemoteCapabilities = { rg: false, fd: false, file: false };

function describeTransportFailure(stderr: string, exitCode: number | null): string {
	const trimmed = stderr.trim();
	if (trimmed) return trimmed;
	if (exitCode === 255) return "ssh could not reach or authenticate against the host";
	return `ssh exited with code ${exitCode}`;
}

function createControlDir(host: string): string {
	const digest = createHash("sha256").update(host).digest("hex").slice(0, 12);
	const dir = join(tmpdir(), `pi-ssh-${process.getuid?.() ?? 0}-${digest}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Non-fatal: ssh reports an unusable socket path itself.
	}
	return dir;
}

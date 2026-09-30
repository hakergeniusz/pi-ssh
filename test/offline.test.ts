/**
 * Offline integration tests: run pi-ssh's transport and tool operations against
 * a fake `ssh` that executes the remote command locally.
 *
 * These cover the parts that only break in production — shell quoting of paths,
 * the `cd <cwd> &&` wrapper, stdin delivery for writes, remote cwd mapping and
 * the grep/find fallbacks — without needing an SSH server.
 *
 * Run with: bun test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createPathMapper } from "../src/path-map.ts";
import {
	createRemoteBashOps,
	createRemoteEditOps,
	createRemoteReadOps,
	createRemoteWriteOps,
	resolveToolPath,
	splitLocalEscape,
} from "../src/remote-ops.ts";
import { createRemoteFindTool, createRemoteGrepTool, createRemoteLsTool, buildSearchArgv } from "../src/remote-search.ts";
import { SshSession } from "../src/session.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fakeSsh = resolve(here, "fake-ssh.sh");

let sandbox: string;
let binDir: string;
let logFile: string;
let session: SshSession;
let sandboxRoot: string;
const localRoot = "/home/dev/project";

beforeAll(async () => {
	sandboxRoot = mkdtempSync(join(tmpdir(), "pi-ssh-fake-"));
	// The fake "remote" is a real directory. The log lives outside it so grep and
	// find never match their own bookkeeping.
	sandbox = join(sandboxRoot, "remote");
	binDir = join(sandboxRoot, "bin");
	mkdirSync(sandbox);
	mkdirSync(binDir);
	logFile = join(sandboxRoot, "invocations.log");
	chmodSync(fakeSsh, 0o755);
	// The fake ssh must win over the real one for this process and its children.
	process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
	process.env.FAKE_SSH_LOG = logFile;
	symlinkSync(fakeSsh, join(binDir, "ssh"));

	writeFileSync(join(sandbox, "README.md"), "# remote project\nhello world\nsecond line\n");
	mkdirSync(join(sandbox, "src"));
	writeFileSync(join(sandbox, "src", "index.ts"), "export const answer = 42;\n");
	writeFileSync(join(sandbox, "src", "util.ts"), "export const helper = () => 'hello';\n");
	mkdirSync(join(sandbox, "dir with spaces"));
	writeFileSync(join(sandbox, "dir with spaces", "quoted.txt"), "spaces are fine\n");

	session = await SshSession.open({ host: "localhost", dir: sandbox });
});

afterAll(() => {
	session?.close();
	rmSync(sandboxRoot, { recursive: true, force: true });
});

function remoteContext(allowLocalBash = false) {
	const mapper = createPathMapper(localRoot, session.cwd);
	return { session, mapper, localCwd: localRoot, allowLocalBash };
}

async function callTool(tool: ReturnType<typeof createRemoteLsTool>, params: unknown): Promise<string> {
	const result = await tool.execute("test-call", params, undefined, undefined, {
		cwd: localRoot,
	} as never);
	return result.content.map((part) => (part.type === "text" ? part.text : `<${part.type}>`)).join("\n");
}

describe("session", () => {
	test("resolves the remote working directory and probes tools", () => {
		expect(session.cwd).toBe(sandbox);
		expect(session.capabilities.rg).toBe(true);
	});

	test("reports ssh failures with ssh's own exit code", async () => {
		await expect(SshSession.open({ host: "nonexistent.invalid", dir: sandbox })).rejects.toThrow(
			/Cannot connect to nonexistent.invalid/,
		);
	});

	test("wraps commands in an explicit cd", async () => {
		const output = await session.capture("pwd");
		expect(output.trim()).toBe(sandbox);
		expect(readFileSync(logFile, "utf-8")).toContain(`cd ${sandbox}`);
	});

	test("streams output through onData", async () => {
		let out = "";
		await session.run("printf 'a\\nb\\n'", { onData: (data) => (out += data.toString()) });
		expect(out).toBe("a\nb\n");
	});

	test("passes stdin to the remote command", async () => {
		const target = join(sandbox, "stdin-target.txt");
		await session.run(`cat > ${JSON.stringify(target)}`, { stdin: "written over stdin\n" });
		expect(readFileSync(target, "utf-8")).toBe("written over stdin\n");
	});

	test("rejects on abort", async () => {
		const controller = new AbortController();
		const promise = session.run("sleep 5", { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await expect(promise).rejects.toThrow("aborted");
	});

	test("abort kills the remote command process, not just the local ssh", async () => {
		const marker = "sleep 2917";
		const alive = () =>
			spawnSync("pgrep", ["-f", marker.replace(/(\d)/, "[$1]")], { encoding: "utf8" }).stdout?.trim() ?? "";

		const controller = new AbortController();
		const promise = session.run(marker, { signal: controller.signal });
		// let the wrapper start and publish its pid before aborting
		await new Promise((r) => setTimeout(r, 300));
		expect(alive()).not.toBe("");

		const started = Date.now();
		controller.abort();
		await expect(promise).rejects.toThrow("aborted");
		// rejection must be prompt, not wait for the command to finish naturally
		expect(Date.now() - started).toBeLessThan(2000);

		for (let i = 0; i < 20 && alive() !== ""; i++) {
			await new Promise((r) => setTimeout(r, 200));
		}
		expect(alive()).toBe("");
	}, 15_000);

	test("timeout kills the remote command and reports the timeout", async () => {
		const marker = "sleep 2923";
		const alive = () =>
			spawnSync("pgrep", ["-f", marker.replace(/(\d)/, "[$1]")], { encoding: "utf8" }).stdout?.trim() ?? "";

		const started = Date.now();
		await expect(session.run(marker, { timeout: 1 })).rejects.toThrow("timeout:1");
		expect(Date.now() - started).toBeLessThan(5000);
		for (let i = 0; i < 20 && alive() !== ""; i++) {
			await new Promise((r) => setTimeout(r, 200));
		}
		expect(alive()).toBe("");
	}, 15_000);
});

describe("read and write operations", () => {
	test("reads a file through the cwd mapping", async () => {
		const ops = createRemoteReadOps(remoteContext());
		const contents = await ops.readFile(join(localRoot, "README.md"));
		expect(contents.toString()).toContain("remote project");
	});

	test("quotes paths containing spaces", async () => {
		const ops = createRemoteReadOps(remoteContext());
		const contents = await ops.readFile(join(localRoot, "dir with spaces", "quoted.txt"));
		expect(contents.toString().trim()).toBe("spaces are fine");
	});

	test("reports a missing file instead of returning empty output", async () => {
		const ops = createRemoteReadOps(remoteContext());
		await expect(ops.readFile(join(localRoot, "nope.txt"))).rejects.toThrow("Path not found");
	});

	test("passes absolute paths outside the mapped directory straight through", async () => {
		const ops = createRemoteReadOps(remoteContext());
		const contents = await ops.readFile("/etc/hostname");
		expect(contents.length).toBeGreaterThan(0);
	});

	test("writes content over stdin", async () => {
		const context = remoteContext();
		const writeOps = createRemoteWriteOps(context);
		const editOps = createRemoteEditOps(context);
		const target = join(localRoot, "src", "generated.ts");

		await writeOps.mkdir(join(localRoot, "src"));
		await writeOps.writeFile(target, "export const generated = true;\n");
		expect(readFileSync(join(sandbox, "src", "generated.ts"), "utf-8")).toBe("export const generated = true;\n");

		// The edit path re-reads, patches and writes back through the same operations.
		const original = (await editOps.readFile(target)).toString();
		await editOps.writeFile(target, original.replace("true", "false"));
		expect(readFileSync(join(sandbox, "src", "generated.ts"), "utf-8")).toContain("false");
		await editOps.access(target);
	});
});

describe("bash operations", () => {
	test("runs commands on the remote host", async () => {
		const ops = createRemoteBashOps(remoteContext());
		let out = "";
		const { exitCode } = await ops.exec("pwd && uname -s", localRoot, {
			onData: (data) => (out += data.toString()),
		});
		expect(exitCode).toBe(0);
		expect(out).toContain(sandbox);
	});

	test("propagates a non-zero exit code instead of throwing", async () => {
		const ops = createRemoteBashOps(remoteContext());
		const { exitCode } = await ops.exec("exit 3", localRoot, { onData: () => {} });
		expect(exitCode).toBe(3);
	});

	test("keeps the local escape hatch disabled by default", async () => {
		const ops = createRemoteBashOps(remoteContext(false));
		let out = "";
		const { exitCode } = await ops.exec(`local: echo $PWD`, localRoot, {
			onData: (data) => (out += data.toString()),
		});
		// The whole string went to the remote shell, which has no `local:` command.
		expect(exitCode).not.toBe(0);
		expect(out).toContain("not found");
	});

	test("runs the local escape hatch locally when allowed", async () => {
		const ops = createRemoteBashOps(remoteContext(true));
		let out = "";
		const { exitCode } = await ops.exec("local: pwd", sandboxRoot, {
			onData: (data) => (out += data.toString()),
		});
		expect(exitCode).toBe(0);
		expect(out.trim()).toBe(sandboxRoot);
	});
});

describe("ls, grep and find", () => {
	test("ls lists the mapped remote directory", async () => {
		const output = await callTool(createRemoteLsTool(remoteContext()), {});
		expect(output).toContain("README.md");
		expect(output).toContain("src/");
		expect(output).toContain("dir with spaces/");
	});

	test("ls honours limit", async () => {
		const output = await callTool(createRemoteLsTool(remoteContext()), { limit: 2 });
		expect(output.split("\n").filter((line) => line && !line.startsWith("[")).length).toBe(2);
		expect(output).toContain("limit reached");
	});

	test("ls fails clearly for a missing directory", async () => {
		await expect(callTool(createRemoteLsTool(remoteContext()), { path: "missing" })).rejects.toThrow(
			"Path not found",
		);
	});

	test("grep reports remote matches with local paths", async () => {
		const output = await callTool(createRemoteGrepTool(remoteContext()), { pattern: "answer" });
		expect(output).toContain("src/index.ts:1:");
		expect(output).not.toContain(sandbox);
	});

	test("grep supports case-insensitive and context", async () => {
		const output = await callTool(createRemoteGrepTool(remoteContext()), {
			pattern: "HELLO",
			ignoreCase: true,
			context: 1,
		});
		expect(output).toContain("README.md:2:");
	});

	test("grep returns no matches without failing", async () => {
		const output = await callTool(createRemoteGrepTool(remoteContext()), { pattern: "zzz-not-there" });
		expect(output).toBe("(no matches)");
	});

	test("find returns relative paths", async () => {
		const output = await callTool(createRemoteFindTool(remoteContext()), { pattern: "*.ts" });
		expect(output).toContain("src/index.ts");
		expect(output).toContain("src/util.ts");
		expect(output).not.toContain(sandbox);
	});

	test("find returns no matches cleanly", async () => {
		const output = await callTool(createRemoteFindTool(remoteContext()), { pattern: "*.nothing" });
		expect(output).toBe("(no matches)");
	});

	test("builds different argv for ripgrep and grep", () => {
		const input = {
			pattern: "a b",
			glob: "*.ts",
			ignoreCase: true,
			literal: true,
			contextLines: 2,
			searchPath: "/srv/app",
		};
		const rg = buildSearchArgv("rg", input).join(" ");
		const grep = buildSearchArgv("grep", input).join(" ");
		expect(rg).toContain("--ignore-case");
		expect(rg).toContain("'a b'");
		expect(grep).toContain("-F");
		expect(grep).toContain("--include='*.ts'");
		expect(rg).not.toBe(grep);
	});
});

describe("tool path resolution", () => {
	test("resolves relative and absolute paths against the session cwd", () => {
		expect(resolveToolPath(undefined, localRoot)).toBe(localRoot);
		expect(resolveToolPath(".", localRoot)).toBe(localRoot);
		expect(resolveToolPath("src/index.ts", localRoot)).toBe(join(localRoot, "src/index.ts"));
		expect(resolveToolPath("/etc/hosts", localRoot)).toBe("/etc/hosts");
	});

	test("splits the local escape prefix", () => {
		expect(splitLocalEscape("local: ls -la")).toEqual({ local: true, command: "ls -la" });
		expect(splitLocalEscape("  local:ls")).toEqual({ local: true, command: "ls" });
		expect(splitLocalEscape("ls -la")).toEqual({ local: false, command: "ls -la" });
	});

	test("sandbox fixture is what the tests assume", () => {
		expect(existsSync(join(sandbox, "src", "index.ts"))).toBe(true);
	});
});

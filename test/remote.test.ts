/**
 * Integration tests against a real SSH server.
 *
 * These are skipped unless `PI_SSH_TEST_HOST` is set, so `bun test` stays
 * hermetic. They need key-based auth (no password prompt) and a writable
 * directory on the remote host.
 *
 *   PI_SSH_TEST_HOST=localhost bun test test/remote.test.ts
 *   PI_SSH_TEST_HOST=user@build-box PI_SSH_TEST_DIR=/srv/scratch bun test test/remote.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPathMapper } from "../src/path-map.ts";
import { createRemoteBashOps, createRemoteEditOps, createRemoteReadOps, createRemoteWriteOps } from "../src/remote-ops.ts";
import { createRemoteFindTool, createRemoteGrepTool, createRemoteLsTool } from "../src/remote-search.ts";
import { SshSession } from "../src/session.ts";

const host = process.env.PI_SSH_TEST_HOST;
const remoteBase = process.env.PI_SSH_TEST_DIR ?? tmpdir();
const localRoot = join(tmpdir(), "pi-ssh-local-cwd");

let session: SshSession;
let remoteDir: string;

async function callTool(tool: ReturnType<typeof createRemoteLsTool>, params: unknown): Promise<string> {
	const result = await tool.execute("test-call", params, undefined, undefined, { cwd: localRoot } as never);
	return result.content.map((part) => (part.type === "text" ? part.text : `<${part.type}>`)).join("\n");
}

describe.skipIf(!host)("real ssh session", () => {
	beforeAll(async () => {
		mkdirSync(localRoot, { recursive: true });
		session = await SshSession.open({ host: host!, dir: remoteBase });
		remoteDir = join(session.cwd, `pi-ssh-test-${process.pid}-${Date.now().toString(36)}`);
		await session.run(`mkdir -p ${JSON.stringify(remoteDir)}`, { cwd: session.cwd });
		await session.run(
			`printf 'hello from the other side\\nsecond line\\n' > README.md; mkdir -p src; printf 'export const answer = 42;\\n' > src/index.ts`,
			{ cwd: remoteDir },
		);
	}, 60_000);

	afterAll(async () => {
		if (session && remoteDir) {
			await session.run(`rm -rf ${JSON.stringify(remoteDir)}`).catch(() => {});
			session.close();
		}
		rmSync(localRoot, { recursive: true, force: true });
	});

	function context() {
		const mapper = createPathMapper(localRoot, remoteDir);
		return { session, mapper, localCwd: localRoot, allowLocalBash: false };
	}

	test("connects and resolves the remote directory", () => {
		expect(session.cwd.startsWith("/")).toBe(true);
		expect(session.describe()).toContain(host!);
	});

	test("defaults to the remote home directory when no dir is given", async () => {
		// Regression guard for `cd '~'`: the default dir must resolve to $HOME,
		// and closing this extra session must not tear down the main session's
		// control socket (each session owns a private control directory).
		const homeSession = await SshSession.open({ host: host! });
		try {
			const remoteHome = (await homeSession.capture("echo $HOME")).trim();
			expect(remoteHome.startsWith("/")).toBe(true);
			expect(homeSession.cwd).toBe(remoteHome);
		} finally {
			homeSession.close();
		}
		expect((await session.capture("echo still-alive")).trim()).toBe("still-alive");
	}, 30_000);

	test("streams command output and exit codes", async () => {
		const ops = createRemoteBashOps(context());
		let out = "";
		const ok = await ops.exec("printf 'streamed\\n'", localRoot, {
			onData: (data) => (out += data.toString()),
		});
		expect(ok.exitCode).toBe(0);
		expect(out).toBe("streamed\n");

		const failed = await ops.exec("exit 7", localRoot, { onData: () => {} });
		expect(failed.exitCode).toBe(7);
	});

	test("runs commands in the mapped remote directory", async () => {
		const ops = createRemoteBashOps(context());
		let out = "";
		await ops.exec("pwd", localRoot, { onData: (data) => (out += data.toString()) });
		// `pwd -P` can differ from the requested path on symlinked hosts.
		const remotePwd = await session.capture(`cd ${JSON.stringify(remoteDir)} && pwd -P`);
		expect(out.trim()).toBe(remotePwd.trim());
	});

	test("reads, writes and edits through the mapping", async () => {
		const readOps = createRemoteReadOps(context());
		const writeOps = createRemoteWriteOps(context());
		const editOps = createRemoteEditOps(context());

		const target = join(localRoot, "src", "generated.ts");
		expect((await readOps.readFile(join(localRoot, "README.md"))).toString()).toContain("hello from the other side");

		await writeOps.mkdir(join(localRoot, "src"));
		await writeOps.writeFile(target, "export const generated = true;\n");
		expect((await readOps.readFile(target)).toString()).toContain("generated = true");

		const original = (await editOps.readFile(target)).toString();
		await editOps.writeFile(target, original.replace("true", "false"));
		expect((await editOps.readFile(target)).toString()).toContain("generated = false");
		await editOps.access(target);
	});

	test("propagates a missing remote file as an error", async () => {
		const ops = createRemoteReadOps(context());
		await expect(ops.readFile(join(localRoot, "definitely-missing.txt"))).rejects.toThrow("Path not found");
	});

	test("lists, searches and finds on the remote host", async () => {
		const ctx = context();
		expect(await callTool(createRemoteLsTool(ctx), {})).toContain("src/");
		expect(await callTool(createRemoteGrepTool(ctx), { pattern: "answer" })).toContain("src/index.ts:1:");
		expect(await callTool(createRemoteFindTool(ctx), { pattern: "*.ts" })).toContain("src/index.ts");
	});

	test("quotes hostile path names", async () => {
		const ctx = context();
		const nasty = join(localRoot, "we ird; $(touch pwned) 'dir'");
		await ctx.session.run(`mkdir -p ${JSON.stringify(nasty)}`);
		const writeOps = createRemoteWriteOps(ctx);
		await writeOps.writeFile(join(nasty, "a b.txt"), "quoted\n");
		const readOps = createRemoteReadOps(ctx);
		expect((await readOps.readFile(join(nasty, "a b.txt"))).toString()).toBe("quoted\n");
		expect(await callTool(createRemoteLsTool(ctx), { path: nasty })).toContain("a b.txt");
		await ctx.session.run(`rm -rf ${JSON.stringify(nasty)}`);
	});

	test("passes large content over stdin without hitting ARG_MAX", async () => {
		const ctx = context();
		const big = "x".repeat(512 * 1024);
		const writeOps = createRemoteWriteOps(ctx);
		const target = join(localRoot, "big.txt");
		await writeOps.writeFile(target, big);
		expect((await createRemoteReadOps(ctx).readFile(target)).length).toBe(big.length);
		await ctx.session.run(`rm -f ${JSON.stringify(target)}`);
	});

	test("abort rejects promptly and kills the remote command", async () => {
		const marker = "sleep 2931";
		const listMarker = () =>
			session
				.capture("pgrep -f 'sleep 29[3]1' || :")
				.then((out) => out.trim())
				.catch(() => "(session gone)");

		const controller = new AbortController();
		const promise = session.run(marker, { signal: controller.signal });
		await new Promise((r) => setTimeout(r, 1000));
		expect(await listMarker()).not.toBe("");

		const started = Date.now();
		controller.abort();
		await expect(promise).rejects.toThrow("aborted");
		// must not wait for the remote command to finish naturally
		expect(Date.now() - started).toBeLessThan(5000);

		for (let i = 0; i < 20; i++) {
			const left = await listMarker();
			if (!left) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(await listMarker()).toBe("");
	}, 30_000);

	test("timeout kills the remote command and reports the timeout", async () => {
		const started = Date.now();
		await expect(session.run("sleep 2947", { timeout: 1 })).rejects.toThrow("timeout:1");
		expect(Date.now() - started).toBeLessThan(5000);
		for (let i = 0; i < 20; i++) {
			const left = await session.capture("pgrep -f 'sleep 29[4]7' || :").then((s) => s.trim());
			if (!left) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		const left = await session.capture("pgrep -f 'sleep 29[4]7' || :");
		expect(left.trim()).toBe("");
	}, 30_000);

	test("the remote fixture exists where the tests expect it", async () => {
		const listing = await session.capture("ls -A", { cwd: remoteDir });
		expect(listing).toContain("README.md");
		expect(listing).toContain("src");
	});
});

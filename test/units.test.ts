/**
 * Unit tests for the pure helpers: flag parsing, path translation and quoting.
 *
 * Run with: bun test
 */

import { describe, expect, test } from "bun:test";
import { createPathMapper } from "../src/path-map.ts";
import { cdCommand, resolveRemoteShell, shellCommand, shellJoin, shellQuote, splitOptionString } from "../src/shell.ts";
import { mapGrepOutput, findPredicate, matchesGlob } from "../src/remote-search.ts";
import { parseSshTarget, TargetParseError } from "../src/target.ts";

describe("parseSshTarget", () => {
	test("accepts a bare destination", () => {
		expect(parseSshTarget("user@host")).toEqual({ host: "user@host" });
	});

	test("splits an absolute remote directory", () => {
		expect(parseSshTarget("user@host:/srv/app")).toEqual({ host: "user@host", dir: "/srv/app" });
	});

	test("keeps a home-relative directory", () => {
		expect(parseSshTarget("user@host:~/code")).toEqual({ host: "user@host", dir: "~/code" });
	});

	test("treats a numeric first segment as a port", () => {
		expect(parseSshTarget("user@host:2222")).toEqual({ host: "user@host:2222" });
		expect(parseSshTarget("user@host:2222:/srv")).toEqual({ host: "user@host:2222", dir: "/srv" });
	});

	test("does not split inside an IPv6 literal", () => {
		expect(parseSshTarget("user@[2001:db8::1]:/srv")).toEqual({ host: "user@[2001:db8::1]", dir: "/srv" });
	});

	test("rejects junk", () => {
		expect(() => parseSshTarget("")).toThrow(TargetParseError);
		expect(() => parseSshTarget("user@host; rm -rf /")).toThrow(TargetParseError);
		expect(() => parseSshTarget("user@host:/srv\nrm")).toThrow(TargetParseError);
	});
});

describe("shell quoting", () => {
	test("leaves safe values alone", () => {
		expect(shellQuote("/srv/app-1/src")).toBe("/srv/app-1/src");
	});

	test("neutralizes expansion and substitution", () => {
		expect(shellQuote("$HOME")).toBe("'$HOME'");
		expect(shellQuote("`id`")).toBe("'`id`'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(shellQuote("")).toBe("''");
	});

	test("quotes every argument it joins", () => {
		expect(shellJoin(["rg", "-e", "a b"])).toBe("rg -e 'a b'");
	});

	test("splits ssh option strings with quotes", () => {
		expect(splitOptionString("-p 2222 -i ~/.ssh/id_ed25519")).toEqual(["-p", "2222", "-i", "~/.ssh/id_ed25519"]);
		expect(splitOptionString('-o "ProxyCommand nc %h %p"')).toEqual(["-o", "ProxyCommand nc %h %p"]);
		expect(splitOptionString("")).toEqual([]);
	});
});

describe("cd command", () => {
	test("keeps tilde prefixes bare so they expand remotely", () => {
		expect(cdCommand("~")).toBe("cd ~");
		expect(cdCommand("~/")).toBe("cd ~");
		expect(cdCommand("~/code")).toBe("cd ~/code");
		expect(cdCommand("~root")).toBe("cd ~root");
	});

	test("quotes only the part after the tilde prefix", () => {
		expect(cdCommand("~/my app")).toBe(`cd ~/'my app'`);
		expect(cdCommand("~root/dir with spaces")).toBe(`cd ~root/'dir with spaces'`);
	});

	test("quotes absolute and relative paths as before", () => {
		expect(cdCommand("/srv/app")).toBe("cd /srv/app");
		expect(cdCommand("/srv/my app")).toBe(`cd '/srv/my app'`);
	});

	test("never lets an unexpanded tilde-like value through unquoted", () => {
		expect(cdCommand("~; rm -rf /")).toBe(`cd '~; rm -rf /'`);
		expect(cdCommand("$HOME")).toBe(`cd '$HOME'`);
	});
});

describe("remote shell wrapper", () => {
	test("runs the script under bash, pi's default shell", () => {
		expect(shellCommand("echo hi")).toBe(`exec bash -c 'echo hi'`);
	});

	test("execs so the shell keeps the session pid and process group", () => {
		expect(shellCommand("cd /srv && { echo $$; ls\n}").startsWith("exec bash -c ")).toBe(true);
	});

	test("quotes a custom shell and the script", () => {
		expect(shellCommand("echo hi", "/opt/my shell")).toBe(`exec '/opt/my shell' -c 'echo hi'`);
	});

	test("neutralizes single quotes, expansions and newlines in the script", () => {
		expect(shellCommand("echo 'it'\\''s' $(id)")).toBe(
			`exec bash -c 'echo '\\''it'\\''\\'\\'''\\''s'\\'' $(id)'`,
		);
		expect(shellCommand("ls\nrm -rf /")).toBe(`exec bash -c 'ls
rm -rf /'`);
	});

	test("defaults to bash and honours PI_SSH_SHELL", () => {
		expect(resolveRemoteShell({})).toBe("bash");
		expect(resolveRemoteShell({ PI_SSH_SHELL: "  " })).toBe("bash");
		expect(resolveRemoteShell({ PI_SSH_SHELL: "/bin/zsh" })).toBe("/bin/zsh");
	});
});

describe("path mapping", () => {
	const mapper = createPathMapper("/home/dev/project/", "/srv/app");

	test("maps the working directory and its children", () => {
		expect(mapper.toRemote("/home/dev/project")).toBe("/srv/app");
		expect(mapper.toRemote("/home/dev/project/src/index.ts")).toBe("/srv/app/src/index.ts");
	});

	test("does not translate lookalike prefixes", () => {
		expect(mapper.toRemote("/home/dev/project-other/file.txt")).toBe("/home/dev/project-other/file.txt");
	});

	test("passes remote absolute paths through unchanged", () => {
		expect(mapper.toRemote("/etc/hosts")).toBe("/etc/hosts");
		expect(mapper.toRemote("~/notes.md")).toBe("~/notes.md");
	});

	test("maps remote output back to local paths", () => {
		expect(mapper.toLocal("/srv/app/src/index.ts")).toBe("/home/dev/project/src/index.ts");
		expect(mapper.toLocal("/srv/app")).toBe("/home/dev/project");
		expect(mapper.toLocal("/var/log/syslog")).toBe("/var/log/syslog");
	});

	test("round-trips paths", () => {
		const path = "/home/dev/project/src/deep/file.ts";
		expect(mapper.toLocal(mapper.toRemote(path))).toBe(path);
	});
});

describe("remote output mapping", () => {
	const mapper = createPathMapper("/home/dev/project", "/srv/app");

	test("rewrites match and context lines to a uniform path:line:text form", () => {
		const rgOutput = [
			"/srv/app/src/index.ts:12:const answer = 42;",
			"/srv/app/src/index.ts-13-// comment",
			"/srv/app/src/index.ts:14-",
		].join("\n");
		expect(mapGrepOutput(rgOutput, { mapper, searchRoot: "/srv/app/src" })).toBe(
			["index.ts:12:const answer = 42;", "index.ts:13:// comment", "index.ts:14:"].join("\n"),
		);
	});

	test("keeps absolute paths when the search root is a file", () => {
		expect(mapGrepOutput("/srv/app/a.ts:1:x", { mapper })).toBe("/home/dev/project/a.ts:1:x");
	});

	test("leaves lines that are not matches alone", () => {
		expect(mapGrepOutput("plain text line", { mapper })).toBe("plain text line");
	});
});

describe("glob helpers", () => {
	test("translates globs into find predicates", () => {
		expect(findPredicate("*.ts")).toBe("-name '*.ts'");
		expect(findPredicate("src/**/*.ts")).toBe("-path './src/*/*.ts'");
		expect(findPredicate("a b.txt")).toBe("-name 'a b.txt'");
	});

	test("matches simple globs", () => {
		expect(matchesGlob("index.ts", "*.ts")).toBe(true);
		expect(matchesGlob("index.js", "*.ts")).toBe(false);
		expect(matchesGlob("a/b/index.ts", "**/*.ts")).toBe(true);
	});
});

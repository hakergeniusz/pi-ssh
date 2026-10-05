import { describe, expect, test } from "bun:test";
import { renderTailWriteCall, tailPreviewEnabled } from "../src/tail-write.ts";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function render(args: unknown, expanded = false): string {
	const component = renderTailWriteCall(args, theme, { cwd: "/tmp", expanded, isPartial: false });
	return (component as unknown as { text: string }).text;
}

function numbered(count: number): string {
	return Array.from({ length: count }, (_, i) => `const line${i} = ${i};`).join("\n");
}

describe("tail write preview", () => {
	test("shows the last line and hides the first", () => {
		const out = render({ file_path: "/tmp/demo.ts", content: numbered(272) });
		expect(out).toContain("const line271 = 271;");
		expect(out).not.toContain("const line0 = 0;");
	});

	test("counts what it hid", () => {
		expect(render({ file_path: "/tmp/demo.ts", content: numbered(272) })).toContain("252 lines above, 272 total");
	});

	test("header keeps the path, shortened", () => {
		expect(render({ file_path: "/tmp/demo.ts", content: "a\nb" })).toStartWith("write /tmp/demo.ts");
	});

	test("files that fit show everything", () => {
		const out = render({ file_path: "/tmp/demo.txt", content: "line 1\nline 2\nline 3" });
		expect(out).toContain("line 1");
		expect(out).not.toContain("above,");
	});

	test("expanded shows the whole file", () => {
		const out = render({ file_path: "/tmp/demo.txt", content: numbered(272) }, true);
		expect(out).toContain("const line0 = 0;");
		expect(out).not.toContain("above,");
	});

	test("a window of one shows one line", () => {
		const previous = process.env.PI_TAIL_PREVIEW_LINES;
		process.env.PI_TAIL_PREVIEW_LINES = "1";
		try {
			const out = render({ file_path: "/tmp/demo.txt", content: "a\nb\nc" });
			expect(out).toContain("c");
			expect(out).not.toContain("\na\n");
		} finally {
			if (previous === undefined) delete process.env.PI_TAIL_PREVIEW_LINES;
			else process.env.PI_TAIL_PREVIEW_LINES = previous;
		}
	});

	test("a non-string content argument is reported", () => {
		expect(render({ file_path: "/tmp/demo.txt", content: 42 })).toContain("invalid content arg");
	});

	test("trailing blank lines are dropped before counting", () => {
		const out = render({ file_path: "/tmp/demo.txt", content: "a\nb\n\n\n" });
		expect(out).not.toContain("above,");
	});

	test("PI_TAIL_PREVIEW=off restores pi's preview", () => {
		const previous = process.env.PI_TAIL_PREVIEW;
		process.env.PI_TAIL_PREVIEW = "off";
		try {
			expect(tailPreviewEnabled()).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PI_TAIL_PREVIEW;
			else process.env.PI_TAIL_PREVIEW = previous;
		}
	});
});
import { describe, expect, test } from "bun:test";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import activate from "../index.ts";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
} as any;

function registeredWrite(): any {
	const tools: any[] = [];
	const pi = {
		on: () => () => {},
		registerTool: (tool: any) => tools.push(tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
	} as any;
	activate(pi);
	const write = tools.find((t) => t.name === "write");
	if (!write) throw new Error("pi-ssh did not register write");
	return write;
}

describe("write preview routing", () => {
	test("pi-ssh's write renders the tail, not the head", () => {
		const write = registeredWrite();
		const content = Array.from({ length: 272 }, (_, i) => `const line${i} = ${i};`).join("\n");
		const component = write.renderCall(
			{ file_path: "/tmp/demo.ts", content },
			theme,
			{ cwd: "/tmp", expanded: false, isPartial: false },
		);
		const text = (component as unknown as { text: string }).text;
		expect(text).toContain("const line271 = 271;");
		expect(text).not.toContain("const line0 = 0;");
		expect(text).toContain("252 lines above, 272 total");
	});

	test("the tool itself is untouched: same name, schema, and execute", () => {
		const write = registeredWrite();
		expect(typeof write.execute).toBe("function");
		expect(typeof write.parameters).toBe("object");
		expect(write.description).toContain("write");
	});

	test("only write gets the tail renderer; the rest are untouched", () => {
		const tools: any[] = [];
		const pi = {
			on: () => () => {},
			registerTool: (tool: any) => tools.push(tool),
			registerCommand: () => {},
			registerShortcut: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
		} as any;
		activate(pi);
		const builtins = createCodingTools("/tmp");
		for (const name of ["read", "edit", "bash"]) {
			const routed = tools.find((t) => t.name === name);
			const builtin = builtins.find((t) => (t as any).name === name) as any;
			expect(routed?.renderCall, name).toBe(builtin?.renderCall);
		}
	});
});
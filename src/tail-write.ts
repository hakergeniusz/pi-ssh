/**
 * Tail write preview: show the END of the file being written, not the beginning.
 *
 * pi's built-in write renderer prints the first 10 lines and a count of what is
 * hidden. While the model streams a 272-line file that is the part nobody cares
 * about — the beginning it wrote twenty lines ago. The interesting lines are the
 * ones arriving now, so this renders the last N instead.
 *
 * It lives here because pi resolves a tool's renderer from the definition
 * registry and resolves name collisions first-wins by extension load order:
 * pi-ssh already owns `write` (it routes execute() to the remote host), so a
 * separate extension registering `write` would simply lose the slot and never
 * render anything.
 *
 * PI_TAIL_PREVIEW_LINES=20 sets the window; PI_TAIL_PREVIEW=off restores pi's
 * head-first preview.
 */

import { homedir } from "node:os";
import { Text } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";

const DEFAULT_TAIL_LINES = 20;

export function tailPreviewEnabled(): boolean {
	return process.env.PI_TAIL_PREVIEW?.trim().toLowerCase() !== "off";
}

function tailLines(): number {
	const raw = process.env.PI_TAIL_PREVIEW_LINES?.trim();
	if (!raw) return DEFAULT_TAIL_LINES;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TAIL_LINES;
}

/** Same contract as pi's own str(): "" for absent, null for the wrong type. */
function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Drop carriage returns, expand tabs, and drop trailing blank lines. */
function toLines(content: string): string[] {
	const lines = content.replace(/\r/g, "").replace(/\t/g, "   ").split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Renderer for the write tool that shows the tail of the content. */
export function renderTailWriteCall(args: any, theme: any, context: any): Text {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const component = (context?.lastComponent as Text | undefined) ?? new Text("", 0, 0);

	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${
		rawPath === null ? theme.fg("error", "<invalid path>") : theme.fg("accent", shortenPath(rawPath || "..."))
	}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
		component.setText(text);
		return component;
	}

	if (fileContent) {
		const lines = toLines(fileContent);
		const total = lines.length;
		const shown = context?.expanded ? lines : lines.slice(Math.max(0, total - tailLines()));
		const hidden = total - shown.length;

		if (hidden > 0) {
			text += `${theme.fg(
				"muted",
				`\n... (${hidden} line${hidden === 1 ? "" : "s"} above, ${total} total,`,
			)} ${theme.fg("accent", "ctrl+o")}${theme.fg("muted", " to expand)")}`;
		}

		// Same highlighting as the built-in, so the tail is not a downgrade.
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const body = lang
			? highlightCode(shown.join("\n"), lang)
			: shown.map((line: string) => theme.fg("toolOutput", line));
		text += `\n\n${body.join("\n")}`;
	}

	component.setText(text);
	return component;
}
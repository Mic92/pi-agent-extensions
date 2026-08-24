import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

// providers.ts consults a shared on-disk usage cache (and rate-limit file)
// before fetching, and falls back to ~/.pi/agent/auth.json for credentials.
// Point both at an empty dir *before import*: otherwise a fresh cache.json
// from a live pi session short-circuits refresh() before it reaches the
// resolver under test, and a real auth.json would turn the fallback path
// into a network call. homedir() is mocked rather than setting $HOME because
// Bun resolves os.homedir() once at startup and ignores later env changes.
const configHome = mkdtempSync(join(os.tmpdir(), "statusline-providers-"));
process.env.XDG_CONFIG_HOME = configHome;
mock.module("node:os", () => ({ ...os, homedir: () => configHome }));

const { createUsageController, setApiKeyResolver } = await import("./providers.ts");

// What pi's ExtensionRunner throws from every ctx getter once the session that
// produced the ctx has been replaced (/new, /resume, /fork) and disposed.
const stale = () => {
	throw new Error("This extension ctx is stale after session replacement or reload.");
};

// Capture the interval callback instead of waiting 10s for a real tick.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let ticks: Array<() => void> = [];

beforeEach(() => {
	ticks = [];
	(globalThis as any).setInterval = (fn: () => void) => {
		ticks.push(fn);
		return ticks.length;
	};
	(globalThis as any).clearInterval = () => {};
});

afterEach(() => {
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
});

afterAll(() => {
	setApiKeyResolver(undefined);
	rmSync(configHome, { recursive: true, force: true });
});

// The tick runs from Timeout._onTimeout, outside any host try/catch, so a
// throw here is an uncaughtException and pi exits. index.ts passes
// currentProvider as getProvider, which reads currentCtx.model.
test("timer tick swallows a getProvider that throws (stale ctx.model)", () => {
	const usage = createUsageController(() => {});
	usage.start(stale as never);
	expect(ticks).toHaveLength(1);
	expect(() => ticks[0]!()).not.toThrow();
	usage.stop();
});

// The resolver closure captures ctx at session_start; the module (and this
// variable) outlives that session because pi caches the extension factory
// and re-runs it per session without re-importing. Every `void usage.refresh()`
// call site turned this rejection into an unhandledRejection.
test("refresh() resolves to the last snapshot when the API-key resolver throws (stale ctx.modelRegistry)", async () => {
	setApiKeyResolver(async () => stale());
	const usage = createUsageController(() => {});
	// Throws before any network I/O: loadAnthropicToken awaits the resolver first.
	await expect(usage.refresh("anthropic")).resolves.toBeUndefined();
});

// What session_shutdown now does. The next session must not reach the old
// closure at all; with no resolver and no auth.json (HOME is empty) the fetch
// reports missing credentials without touching the network.
test("a cleared resolver is not invoked; refresh falls back to auth.json", async () => {
	let calls = 0;
	setApiKeyResolver(async () => {
		calls++;
		return stale();
	});
	setApiKeyResolver(undefined);
	const usage = createUsageController(() => {});
	await expect(usage.refresh("anthropic")).resolves.toBeUndefined();
	expect(calls).toBe(0);
});

// Same rejection, reached from the timer instead of an event handler:
// first tick has lastFetchAt=0, so it always attempts a refresh.
test("tick-driven refresh failure does not surface as an unhandledRejection", async () => {
	setApiKeyResolver(async () => stale());
	let unhandled = 0;
	const onUnhandled = () => void unhandled++;
	process.on("unhandledRejection", onUnhandled);
	try {
		const usage = createUsageController(() => {});
		usage.start(() => "anthropic");
		ticks[0]!();
		await new Promise((r) => setTimeout(r, 20));
		expect(unhandled).toBe(0);
		usage.stop();
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

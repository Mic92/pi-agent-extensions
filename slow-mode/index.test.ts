/**
 * Review-gate behaviour: what the user is shown before approving, and what
 * actually reaches the tool afterwards — driven through index.ts with a
 * scripted fake UI (no real TUI, temp dirs for the working tree).
 *
 * The diff backend is pinned to the built-in Myers implementation so the
 * assertions describe slow mode's own output rather than whichever of
 * difftastic/delta happens to be installed on the machine running the tests.
 *
 * Run with: bun test slow-mode
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import slowMode from "./index.ts";

// ── fakes ────────────────────────────────────────────────────────────────

interface Component {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

const fakeTheme = { fg: (_color: string, s: string) => s };

/** A TUI stand-in that records the lifecycle calls slow mode makes on it. */
function makeTui(columns = 100, rows = 40) {
  const log: string[] = [];
  const tui = {
    terminal: { columns, rows },
    requestRender() {
      log.push("render");
    },
    stop() {
      log.push("stop");
    },
    start() {
      log.push("start");
    },
  };
  return { tui, log };
}

const KEY = { enter: "\r", escape: "\x1b", ctrlE: "\x05", down: "\x1b[B" };

/** Fake ExtensionAPI: captures event handlers and registered commands. */
function makePi() {
  const eventHandlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const commands = new Map<string, { handler: (args: string | undefined, ctx: unknown) => Promise<void> }>();
  const emitted: { channel: string; data: unknown }[] = [];
  const pi = {
    on(name: string, fn: (event: unknown, ctx: unknown) => unknown) {
      if (!eventHandlers.has(name)) eventHandlers.set(name, []);
      eventHandlers.get(name)!.push(fn);
    },
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
      on() {
        return () => {};
      },
    },
    registerCommand(name: string, def: { handler: (args: string | undefined, ctx: unknown) => Promise<void> }) {
      commands.set(name, def);
    },
  };
  const fire = async (name: string, event: unknown, ctx: unknown) => {
    let result: unknown;
    for (const fn of eventHandlers.get(name) ?? []) result = await fn(event, ctx);
    return result;
  };
  return { pi, fire, commands, emitted };
}

/** A ctx whose ui.custom hands the live component back to the test. */
function makeCtx(cwd: string, tui: unknown = makeTui().tui) {
  const state: { component?: Component; notifications: string[] } = { notifications: [] };
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      theme: fakeTheme,
      setStatus() {},
      notify(message: string) {
        state.notifications.push(message);
      },
      custom<T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown): Promise<T> {
        return new Promise<T>((resolve) => {
          state.component = factory(tui, fakeTheme, undefined, (result: T) => {
            state.component = undefined;
            resolve(result);
          }) as Component;
        });
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, state };
}

/** Wait for the review UI to mount, then return it. */
async function reviewUI(state: { component?: Component }): Promise<Component> {
  for (let i = 0; i < 200 && !state.component; i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  if (!state.component) throw new Error("review UI never appeared");
  return state.component;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const screen = (component: Component, width = 100) =>
  component.render(width).map(stripAnsi).join("\n");

// ── harness ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-mode-test-"));
  tempDirs.push(dir);
  return dir;
};

const savedDiffBackend = process.env.PI_SLOW_MODE_DIFF;
const savedPath = process.env.PATH;

beforeEach(() => {
  process.env.PI_SLOW_MODE_DIFF = "builtin";
});

afterEach(() => {
  if (savedDiffBackend === undefined) delete process.env.PI_SLOW_MODE_DIFF;
  else process.env.PI_SLOW_MODE_DIFF = savedDiffBackend;
  process.env.PATH = savedPath;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Put fake `difft` and `delta` executables at the front of PATH.
 *
 * Backend switching is otherwise untestable: which backends exist depends on
 * the machine running the suite. Shadowing both names makes the cycle order
 * deterministic, and gives each backend an output signature the assertions
 * can look for. The stubs shadow any real installation because the stub dir
 * comes first.
 */
function stubBackends(): { argvFor: (tool: string) => string } {
  const dir = tmp();
  // difft's first line is a "<path> --- <Language>" banner that slow mode drops
  write(dir, "difft", "echo 'staged.ts --- TypeScript'\necho 'STRUCTURAL BODY'\n");
  write(dir, "delta", "cat >/dev/null\necho 'DELTA BODY'\n");
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;

  /** Each stub records how it was invoked, so flag choices are assertable. */
  function write(at: string, name: string, body: string) {
    const bin = path.join(at, name);
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > '${at}/${name}.argv'\n${body}`, "utf-8");
    fs.chmodSync(bin, 0o755);
  }

  return {
    argvFor(tool: string) {
      const record = path.join(dir, `${tool}.argv`);
      return fs.existsSync(record) ? fs.readFileSync(record, "utf-8").trim() : "";
    },
  };
}

/**
 * Make every backend probe fail.
 *
 * Emptying PATH is not enough — execvp falls back to a default search path,
 * so a real difftastic on the machine still gets found. Shadowing `which`
 * itself with a stub that always exits non-zero is what actually simulates a
 * machine with neither tool installed.
 */
function stubNoBackends(): void {
  const dir = tmp();
  const bin = path.join(dir, "which");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", "utf-8");
  fs.chmodSync(bin, 0o755);
  process.env.PATH = dir;
}

/** Install the extension and switch the gate on. */
async function installEnabled(cwd: string, tui?: unknown) {
  const made = makePi();
  slowMode(made.pi as never);
  const { ctx, state } = makeCtx(cwd, tui ?? makeTui().tui);
  await made.commands.get("slow-mode")!.handler(undefined, ctx);
  return { ...made, ctx, state };
}

/**
 * Fire an `edit` tool call and drive the review to a decision.
 *
 * `script` receives the mounted component; whatever it does must end the
 * review (approve/reject), otherwise the returned promise never settles.
 */
async function review(
  cwd: string,
  input: Record<string, unknown>,
  script: (ui: Component) => void | Promise<void>,
  toolName: "edit" | "write" = "edit",
) {
  const gate = await installEnabled(cwd);
  const decision = gate.fire("tool_call", { toolCallId: "call-1", toolName, input }, gate.ctx);
  const ui = await reviewUI(gate.state);
  const rendered = screen(ui);
  await script(ui);
  return { result: await decision, rendered, input, ...gate };
}

// ── tests ────────────────────────────────────────────────────────────────

// The whole point of the gate is that the user sees the change in its real
// setting. Diffing the raw oldText/newText fragments produces hunk headers
// counted from the fragment, not the file — so a change at line 40 claimed to
// be at line 1 and showed no surrounding code.
describe("edits are diffed against the file on disk", () => {
  const file = (dir: string) => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    lines[29] = "const target = 1;";
    fs.writeFileSync(path.join(dir, "app.ts"), `${lines.join("\n")}\n`, "utf-8");
  };

  test("hunk headers carry real file line numbers", async () => {
    const dir = tmp();
    file(dir);
    const { rendered } = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const target = 1;", newText: "const target = 2;" }] },
      (ui) => ui.handleInput(KEY.enter),
    );
    expect(rendered).toContain("@@ -27,7 +27,7 @@");
    expect(rendered).toContain("-const target = 1;");
    expect(rendered).toContain("+const target = 2;");
  });

  test("surrounding lines from the file are shown as context", async () => {
    const dir = tmp();
    file(dir);
    const { rendered } = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const target = 1;", newText: "const target = 2;" }] },
      (ui) => ui.handleInput(KEY.enter),
    );
    // Context the fragment itself never contained
    expect(rendered).toContain(" line 27");
    expect(rendered).toContain(" line 33");
  });

  test("the header says the diff has full-file context", async () => {
    const dir = tmp();
    file(dir);
    const { rendered } = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const target = 1;", newText: "const target = 2;" }] },
      (ui) => ui.handleInput(KEY.enter),
    );
    expect(rendered).toContain("full-file context");
  });
});

// Multiple edits used to be concatenated into one blob and diffed against
// another blob, which invented changes that were never proposed. Applying them
// to the document instead keeps each change in its own hunk.
describe("multi-edit calls", () => {
  test("distant changes render as separate hunks", async () => {
    const dir = tmp();
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    lines[4] = "alpha";
    lines[49] = "omega";
    fs.writeFileSync(path.join(dir, "app.ts"), `${lines.join("\n")}\n`, "utf-8");

    const { rendered } = await review(
      dir,
      {
        path: "app.ts",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "omega", newText: "OMEGA" },
        ],
      },
      (ui) => ui.handleInput(KEY.enter),
    );

    expect(rendered).toContain("@@ -2,7 +2,7 @@");
    expect(rendered).toContain("@@ -47,7 +47,7 @@");
    expect(rendered).toContain("-alpha");
    expect(rendered).toContain("+ALPHA");
    expect(rendered).toContain("-omega");
    expect(rendered).toContain("+OMEGA");
    // Nothing between the two hunks should be reported as changed
    expect(rendered).not.toContain("-line 30");
  });

  test("unchanged middle of the file is collapsed", async () => {
    const dir = tmp();
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    lines[4] = "alpha";
    lines[49] = "omega";
    fs.writeFileSync(path.join(dir, "app.ts"), `${lines.join("\n")}\n`, "utf-8");

    const { rendered } = await review(
      dir,
      {
        path: "app.ts",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "omega", newText: "OMEGA" },
        ],
      },
      (ui) => ui.handleInput(KEY.enter),
    );
    expect(rendered).not.toContain("line 25");
  });
});

// Without a readable file there is nothing to anchor to, so the gate still
// works — it just says so, and stops offering to fold manual edits back.
describe("fallback when the file cannot be reconstructed", () => {
  test("a missing file degrades to a fragment diff", async () => {
    const dir = tmp();
    const { rendered } = await review(
      dir,
      { path: "ghost.ts", edits: [{ oldText: "a", newText: "b" }] },
      (ui) => ui.handleInput(KEY.enter),
    );
    expect(rendered).toContain("fragment only");
    expect(rendered).toContain("-a");
    expect(rendered).toContain("+b");
  });

  test("a fragment that does not match degrades too", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "totally different\n", "utf-8");
    const { rendered } = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "nope", newText: "yep" }] },
      (ui) => ui.handleInput(KEY.enter),
    );
    expect(rendered).toContain("fragment only");
  });

  test("multi-edit fragment fallback hides the edit affordance", async () => {
    const dir = tmp();
    const { rendered } = await review(
      dir,
      {
        path: "ghost.ts",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      },
      (ui) => ui.handleInput(KEY.enter),
    );
    expect(rendered).not.toContain("Ctrl+E");
  });
});

// A write over an existing file is a destructive act; showing the full new
// content hides what is being lost.
describe("write review", () => {
  test("overwriting an existing file shows a diff", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "notes.md"), "keep\nold line\n", "utf-8");
    const { rendered } = await review(
      dir,
      { path: "notes.md", content: "keep\nnew line\n" },
      (ui) => ui.handleInput(KEY.enter),
      "write",
    );
    expect(rendered).toContain("OVERWRITE");
    expect(rendered).toContain("-old line");
    expect(rendered).toContain("+new line");
  });

  test("a genuinely new file shows its content", async () => {
    const dir = tmp();
    const { rendered } = await review(
      dir,
      { path: "fresh.md", content: "hello\nworld\n" },
      (ui) => ui.handleInput(KEY.enter),
      "write",
    );
    expect(rendered).toContain("NEW FILE");
    expect(rendered).toContain("hello");
    expect(rendered).toContain("world");
  });
});

// The gate's contract with the agent.
describe("decisions", () => {
  test("Enter lets the tool run untouched", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const input = { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] };
    const { result } = await review(dir, input, (ui) => ui.handleInput(KEY.enter));
    expect(result).toBeUndefined();
    expect(input.edits).toEqual([{ oldText: "const a = 1;", newText: "const a = 2;" }]);
  });

  test("Esc blocks the tool with a reason", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const { result } = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      (ui) => ui.handleInput(KEY.escape),
    );
    expect(result).toEqual({ block: true, reason: "User rejected the edit in slow mode review." });
  });

  test("the gate is inert until /slow-mode is used", async () => {
    const dir = tmp();
    const made = makePi();
    slowMode(made.pi as never);
    const { ctx, state } = makeCtx(dir);
    const result = await made.fire(
      "tool_call",
      { toolCallId: "c", toolName: "edit", input: { path: "app.ts", edits: [] } },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(state.component).toBeUndefined();
  });

  test("waiting and resolved are announced around the review", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const { emitted } = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      (ui) => ui.handleInput(KEY.escape),
    );
    expect(emitted.map((e) => e.channel)).toEqual(["slow-mode:waiting", "slow-mode:resolved"]);
    expect(emitted[1].data).toMatchObject({ approved: false });
  });
});

// Ctrl+E hands the *result* to the editor, not a search/replace fragment, so
// the edited document has to be folded back into a replacement the edit tool
// can actually apply. Writing it to input.newText (as before) was silently
// dropped, because the tool only reads edits[].
describe("manual edits fold back into the tool input", () => {
  const setup = (dir: string) => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    lines[9] = "const a = 1;";
    fs.writeFileSync(path.join(dir, "app.ts"), `${lines.join("\n")}\n`, "utf-8");
  };

  /** Drive a review, hand-editing the staged result the first time it mounts. */
  async function reviewWithHandEdit(
    dir: string,
    input: Record<string, unknown>,
    rewrite: (text: string) => string,
    tui?: unknown,
  ) {
    const gate = await installEnabled(dir, tui);
    const editor = process.env.VISUAL;
    // Ctrl+E shells out to $VISUAL; a tiny sed-alike stands in for the editor
    const script = path.join(dir, "fake-editor.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.VISUAL = script;

    try {
      const decision = gate.fire("tool_call", { toolCallId: "call-1", toolName: "edit", input }, gate.ctx);
      const first = await reviewUI(gate.state);
      // Stand in for the editor: rewrite the staged file, then trigger the reload
      const staged = stagedPath(first);
      fs.writeFileSync(staged, rewrite(fs.readFileSync(staged, "utf-8")), "utf-8");
      first.handleInput(KEY.ctrlE);
      const second = await reviewUI(gate.state);
      second.handleInput(KEY.enter);
      return { result: await decision, ...gate };
    } finally {
      if (editor === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = editor;
    }
  }

  /**
   * Recover the staged "new" file the component is rendering: the only live
   * `pi-slow-mode-*\/stage-*\/new\/<file>` on disk while a review is open.
   */
  function stagedPath(_ui: Component): string {
    const candidates: string[] = [];
    for (const root of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("pi-slow-mode-"))) {
      const rootPath = path.join(os.tmpdir(), root);
      let stages: string[];
      try {
        stages = fs.readdirSync(rootPath).filter((n) => n.startsWith("stage-"));
      } catch {
        continue;
      }
      for (const stage of stages) {
        const dir = path.join(rootPath, stage, "new");
        const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        for (const file of files) candidates.push(path.join(dir, file));
      }
    }
    if (candidates.length !== 1) {
      throw new Error(`expected exactly one staged file, found ${candidates.length}`);
    }
    return candidates[0];
  }

  test("the hand-edited result replaces edits[] with one minimal change", async () => {
    const dir = tmp();
    setup(dir);
    const input: Record<string, unknown> = {
      path: "app.ts",
      edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
    };
    await reviewWithHandEdit(dir, input, (text) => text.replace("const a = 2;", "const a = 42;"));

    const edits = input.edits as { oldText: string; newText: string }[];
    expect(edits).toHaveLength(1);
    expect(edits[0].newText).toContain("const a = 42;");
    // Minimal, not the whole document
    expect(edits[0].oldText).not.toContain("line 1\n");
    expect(edits[0].oldText).toContain("const a = 1;");
  });

  test("the replacement still matches the file exactly once", async () => {
    const dir = tmp();
    setup(dir);
    const input: Record<string, unknown> = {
      path: "app.ts",
      edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
    };
    await reviewWithHandEdit(dir, input, (text) => text.replace("const a = 2;", "const a = 42;"));

    const edits = input.edits as { oldText: string; newText: string }[];
    const document = fs.readFileSync(path.join(dir, "app.ts"), "utf-8");
    expect(document.split(edits[0].oldText).length - 1).toBe(1);
  });

  test("the tool result records that the content was modified", async () => {
    const dir = tmp();
    setup(dir);
    const input: Record<string, unknown> = {
      path: "app.ts",
      edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
    };
    const gate = await reviewWithHandEdit(dir, input, (text) => text.replace("const a = 2;", "const a = 42;"));

    const patched = (await gate.fire(
      "tool_result",
      { toolCallId: "call-1", toolName: "edit", content: [{ type: "text", text: "ok" }] },
      gate.ctx,
    )) as { content: { text: string }[] };
    expect(patched.content.at(-1)!.text).toContain("modified in slow mode review");
  });
});

// The bug this gate had: pi keeps stdin in raw mode with its own handler
// attached, so a child spawned with stdio:"inherit" never sees a keystroke —
// the pager or editor appears but arrow keys scroll pi's transcript behind it.
// Suspending the TUI for the duration is what hands the terminal over.
describe("external tools get the terminal", () => {
  test("the TUI is stopped around the editor and restarted after", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const script = path.join(dir, "fake-editor.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const editor = process.env.VISUAL;
    process.env.VISUAL = script;
    const { tui, log } = makeTui();
    try {
      const gate = await installEnabled(dir, tui);
      const decision = gate.fire(
        "tool_call",
        {
          toolCallId: "call-1",
          toolName: "edit",
          input: { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
        },
        gate.ctx,
      );
      const first = await reviewUI(gate.state);
      log.length = 0;
      first.handleInput(KEY.ctrlE);
      const second = await reviewUI(gate.state);
      second.handleInput(KEY.enter);
      await decision;

      const lifecycle = log.filter((entry) => entry !== "render");
      expect(lifecycle).toEqual(["stop", "start"]);
    } finally {
      if (editor === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = editor;
    }
  });

  test("a full repaint is requested once the editor exits", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const script = path.join(dir, "fake-editor.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const editor = process.env.VISUAL;
    process.env.VISUAL = script;
    const { tui, log } = makeTui();
    try {
      const gate = await installEnabled(dir, tui);
      const decision = gate.fire(
        "tool_call",
        {
          toolCallId: "call-1",
          toolName: "edit",
          input: { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
        },
        gate.ctx,
      );
      const first = await reviewUI(gate.state);
      log.length = 0;
      first.handleInput(KEY.ctrlE);
      const second = await reviewUI(gate.state);
      second.handleInput(KEY.enter);
      await decision;

      expect(log.indexOf("render")).toBeGreaterThan(log.indexOf("start"));
    } finally {
      if (editor === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = editor;
    }
  });
});

// Staged copies of the user's source sit in /tmp until the session ends, so
// the gate has to be tidy about them.
describe("staging housekeeping", () => {
  const stagingDirs = () =>
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-slow-mode-"));

  test("nothing is staged until a review actually happens", async () => {
    const before = stagingDirs();
    const made = makePi();
    slowMode(made.pi as never);
    const { ctx } = makeCtx(tmp());
    await made.commands.get("slow-mode")!.handler(undefined, ctx);
    expect(stagingDirs()).toEqual(before);
  });

  test("the staged copies are removed once a decision is made", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const before = new Set(stagingDirs());

    await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      (ui) => ui.handleInput(KEY.enter),
    );

    const created = stagingDirs().filter((name) => !before.has(name));
    expect(created).toHaveLength(1);
    expect(fs.readdirSync(path.join(os.tmpdir(), created[0]))).toEqual([]);
  });

  test("session shutdown takes the staging directory with it", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const before = new Set(stagingDirs());

    const gate = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      (ui) => ui.handleInput(KEY.enter),
    );
    const created = stagingDirs().filter((name) => !before.has(name));
    expect(created).toHaveLength(1);

    await gate.fire("session_shutdown", {}, gate.ctx);
    expect(fs.existsSync(path.join(os.tmpdir(), created[0]))).toBe(false);
  });
});

// Layout and context controls only make sense for diffs, and must not be
// advertised on a plain new-file preview.
describe("review controls", () => {
  test("diffs advertise the context and backend keys", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const { rendered } = await review(
      dir,
      { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      (ui) => ui.handleInput(KEY.enter),
    );
    expect(rendered).toContain("[/] context");
    expect(rendered).toContain("b backend");
  });

  test("a new-file preview offers no diff controls at all", async () => {
    const dir = tmp();
    const { rendered } = await review(
      dir,
      { path: "fresh.md", content: "hello\n" },
      (ui) => ui.handleInput(KEY.enter),
      "write",
    );
    expect(rendered).not.toContain("s layout");
    expect(rendered).not.toContain("b backend");
    expect(rendered).not.toContain("[/] context");
  });

  test("] widens the diff context", async () => {
    const dir = tmp();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    lines[19] = "const a = 1;";
    fs.writeFileSync(path.join(dir, "app.ts"), `${lines.join("\n")}\n`, "utf-8");

    const gate = await installEnabled(dir);
    const decision = gate.fire(
      "tool_call",
      {
        toolCallId: "call-1",
        toolName: "edit",
        input: { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      },
      gate.ctx,
    );
    const ui = await reviewUI(gate.state);
    expect(screen(ui)).toContain("@@ -17,7 +17,7 @@");
    ui.handleInput("]");
    ui.handleInput("]");
    expect(screen(ui)).toContain("@@ -15,11 +15,11 @@");
    ui.handleInput(KEY.enter);
    await decision;
  });

  test("scrolling moves the window over a long diff", async () => {
    const dir = tmp();
    const before = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = Array.from({ length: 200 }, (_, i) => `LINE ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(dir, "big.txt"), `${before}\n`, "utf-8");

    const gate = await installEnabled(dir);
    const decision = gate.fire(
      "tool_call",
      { toolCallId: "call-1", toolName: "edit", input: { path: "big.txt", edits: [{ oldText: before, newText: after }] } },
      gate.ctx,
    );
    const ui = await reviewUI(gate.state);
    const top = screen(ui);
    expect(top).toContain("lines 1–");
    ui.handleInput(KEY.down);
    ui.handleInput(KEY.down);
    const scrolled = screen(ui);
    expect(scrolled).toContain("lines 3–");
    expect(scrolled).not.toEqual(top);
    ui.handleInput("G");
    expect(screen(ui)).not.toEqual(scrolled);
    ui.handleInput(KEY.enter);
    await decision;
  });
});

// `b` picks the diff backend from inside the gate, so a diff that difftastic
// has over-collapsed can be re-read as a plain unified diff without leaving
// the review and restarting pi with a different PI_SLOW_MODE_DIFF.
describe("switching diff backend with b", () => {
  /** Start a review of a one-line edit and hand back the mounted UI. */
  async function open(dir: string) {
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const gate = await installEnabled(dir);
    const decision = gate.fire(
      "tool_call",
      {
        toolCallId: "call-1",
        toolName: "edit",
        input: { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      },
      gate.ctx,
    );
    return { ui: await reviewUI(gate.state), decision, gate };
  }

  test("cycles difft → delta → builtin and back", async () => {
    stubBackends();
    const { ui, decision } = await open(tmp());

    // Pinned to builtin by the suite, so the first press moves to the top
    expect(screen(ui)).toContain("builtin diff");

    ui.handleInput("b");
    expect(screen(ui)).toContain("difft");

    ui.handleInput("b");
    expect(screen(ui)).toContain("delta");

    ui.handleInput("b");
    expect(screen(ui)).toContain("builtin diff");

    ui.handleInput(KEY.enter);
    await decision;
  });

  test("the diff is re-rendered through the new backend", async () => {
    stubBackends();
    const { ui, decision } = await open(tmp());

    expect(screen(ui)).toContain("-const a = 1;");

    ui.handleInput("b");
    const structural = screen(ui);
    expect(structural).toContain("STRUCTURAL BODY");
    expect(structural).not.toContain("-const a = 1;");

    ui.handleInput("b");
    expect(screen(ui)).toContain("DELTA BODY");

    ui.handleInput(KEY.enter);
    await decision;
  });

  test("the choice carries into the next review", async () => {
    stubBackends();
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const gate = await installEnabled(dir);

    const edit = (id: string, newText: string) =>
      gate.fire(
        "tool_call",
        {
          toolCallId: id,
          toolName: "edit",
          input: { path: "app.ts", edits: [{ oldText: "const a = 1;", newText }] },
        },
        gate.ctx,
      );

    const first = edit("call-1", "const a = 2;");
    const firstUi = await reviewUI(gate.state);
    firstUi.handleInput("b");
    expect(screen(firstUi)).toContain("difft");
    firstUi.handleInput(KEY.enter);
    await first;

    const second = edit("call-2", "const a = 3;");
    const secondUi = await reviewUI(gate.state);
    expect(screen(secondUi)).toContain("difft");
    secondUi.handleInput(KEY.enter);
    await second;
  });

  test("with no external backend installed it stays on builtin", async () => {
    stubNoBackends();
    const { ui, decision } = await open(tmp());

    expect(screen(ui)).toContain("builtin diff");
    ui.handleInput("b");
    const after = screen(ui);
    expect(after).toContain("builtin diff");
    expect(after).toContain("-const a = 1;");

    ui.handleInput(KEY.enter);
    await decision;
  });
});

// Only difft and delta can render two columns. `s` used to be offered
// unconditionally, so on a wide terminal the header announced "side-by-side"
// over a built-in unified diff and the key toggled nothing but the label.
describe("the layout toggle follows the backend", () => {
  /** Start a review of a one-line edit and hand back the mounted UI. */
  async function open(dir: string) {
    fs.writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n", "utf-8");
    const gate = await installEnabled(dir);
    const decision = gate.fire(
      "tool_call",
      {
        toolCallId: "call-1",
        toolName: "edit",
        input: { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
      },
      gate.ctx,
    );
    return { ui: await reviewUI(gate.state), decision, gate };
  }

  test("the built-in advertises no layout key and claims no layout", async () => {
    stubNoBackends();
    const { ui, decision } = await open(tmp());

    const rendered = screen(ui);
    expect(rendered).not.toContain("s layout");
    expect(rendered).not.toContain("side-by-side");
    expect(rendered).not.toContain("inline");

    ui.handleInput(KEY.enter);
    await decision;
  });

  test("the key appears once a column-capable backend is selected", async () => {
    stubBackends();
    const { ui, decision } = await open(tmp());

    expect(screen(ui)).not.toContain("s layout");
    ui.handleInput("b");
    expect(screen(ui)).toContain("s layout");

    ui.handleInput(KEY.enter);
    await decision;
  });

  test("delta drops --color-only for columns and keeps it inline", async () => {
    const stubs = stubBackends();
    const { ui, decision } = await open(tmp());

    // builtin → difft → delta
    ui.handleInput("b");
    ui.handleInput("b");
    screen(ui);
    expect(stubs.argvFor("delta")).toContain("--color-only");
    expect(stubs.argvFor("delta")).not.toContain("--side-by-side");

    // The fake terminal is 100 columns, so two columns need an explicit toggle
    ui.handleInput("s");
    screen(ui);
    const columns = stubs.argvFor("delta");
    expect(columns).toContain("--side-by-side");
    expect(columns).not.toContain("--color-only");
    // delta's own file banner would duplicate the review header above it
    expect(columns).toContain("--file-style omit");

    ui.handleInput(KEY.enter);
    await decision;
  });

  test("difft is asked for the layout the header advertises", async () => {
    const stubs = stubBackends();
    const { ui, decision } = await open(tmp());

    ui.handleInput("b");
    screen(ui);
    expect(stubs.argvFor("difft")).toContain("--display inline");

    ui.handleInput("s");
    expect(screen(ui)).toContain("side-by-side");
    expect(stubs.argvFor("difft")).toContain("--display side-by-side");

    ui.handleInput(KEY.enter);
    await decision;
  });
});

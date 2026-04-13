/**
 * Slow Mode Extension
 *
 * Intercepts write and edit tool calls, letting the user review proposed
 * changes before they are applied.
 *
 * Review rendering
 * ----------------
 * - Edits are reconstructed against the *real file on disk*: the extension
 *   reads the target file, applies every `edits[]` entry, and diffs the full
 *   before/after documents. That means hunk line numbers and context lines are
 *   the real ones, and syntax-aware diff tools get complete, parseable files.
 * - The diff body is produced by the first available backend:
 *     1. difftastic (`difft`) — structural, syntax-aware diff
 *     2. delta — unified diff with syntax + word-level highlighting
 *     3. built-in Myers unified diff with theme colours
 *   Override with PI_SLOW_MODE_DIFF=difft|delta|builtin.
 * - `s` toggles side-by-side / inline layout, `[`/`]` change context lines,
 *   `b` cycles the backend live (skipping any that are not installed).
 *   Columns need difft or delta; the built-in renderer is inline-only, so `s`
 *   is hidden while it is active rather than offered as a dead toggle.
 *
 * Key bindings inside the review gate
 * -----------------------------------
 * - Enter approves, Esc rejects.
 * - Ctrl+E opens the proposed result in $VISUAL/$EDITOR; the diff is
 *   regenerated afterwards and shown again for approval.
 * - Ctrl+O opens the full diff in a pager for unconstrained scrolling.
 * - j/k, u/d, gg/G scroll the inline preview.
 *
 * Terminal handover
 * -----------------
 * Any external process (editor, pager) is spawned with the pi TUI suspended
 * (`tui.stop()` / `tui.start()`), exactly like pi's own Ctrl+G external editor.
 * Without this, pi keeps stdin in raw mode and swallows the arrow keys, so the
 * external viewer appears but cannot be scrolled.
 *
 * When content is edited:
 * - The actual write/edit operation uses the edited content
 * - A note is appended to the tool result indicating content was modified
 * - The collapsed snippet shows the original LLM proposal (not the edited
 *   version). This is intentional - it shows what the LLM wanted vs. what was
 *   actually applied.
 *
 * In non-interactive mode (no UI), slow mode is a no-op.
 */

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve, relative, extname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, type TUI } from "@mariozechner/pi-tui";

/** A single search/replace pair, as accepted by the built-in edit tool. */
interface EditFragment {
  oldText: string;
  newText: string;
}

export default function slowMode(pi: ExtensionAPI) {
  // State: whether slow mode is currently enabled
  let enabled = false;

  // Track tool calls where content was edited
  // Maps toolCallId -> { originalContent, editedContent }
  const editedCalls = new Map<string, { original: string; edited: string }>();

  // The app's TUI instance, captured the first time a review UI is mounted.
  // Needed to suspend/resume the terminal around external processes.
  let activeTui: TUI | null = null;

  // Staging directory: holds proposed file changes for review.
  //
  // Created on first use rather than at load time, so the overwhelming majority
  // of sessions — where slow mode is never switched on — leave nothing behind
  // even if they exit without a clean shutdown. mkdtempSync gives an
  // unpredictable name, closing symlink and tmpdir races.
  let tmpDirPath: string | null = null;
  function stagingRoot(): string {
    if (!tmpDirPath) {
      tmpDirPath = mkdtempSync(join(tmpdir(), "pi-slow-mode-"));
    }
    return tmpDirPath;
  }

  // Clean up staging directory on session shutdown
  pi.on("session_shutdown", async () => {
    if (!tmpDirPath) return;
    try {
      rmSync(tmpDirPath, { recursive: true, force: true });
      tmpDirPath = null;
    } catch {
      // Best-effort cleanup
    }
  });

  ////----------------------------------------
  ///     Toggle command
  //------------------------------------------

  // Register /slow-mode command — toggle the interception gate on/off
  pi.registerCommand("slow-mode", {
    description: "Toggle slow mode — review write/edit changes before applying",
    handler: async (_args, ctx) => {
      // No-op in headless mode (no TUI available)
      if (!ctx.hasUI) {
        return;
      }

      // Flip the enabled flag
      enabled = !enabled;
      if (enabled) {
        // Show status bar indicator when active
        ctx.ui.setStatus("slow-mode", ctx.ui.theme.fg("warning", "\uf256 slow"));
        ctx.ui.notify("Slow mode enabled — write/edit changes require approval", "info");
      } else {
        // Clear status bar indicator when disabled
        ctx.ui.setStatus("slow-mode", undefined);
        ctx.ui.notify("Slow mode disabled", "info");
      }
    },
  });

  ////----------------------------------------
  ///     Tool call interception
  //------------------------------------------

  // Hook into tool_call event — fires BEFORE tool execution
  // Returning { block: true, reason } prevents the tool from running
  pi.on("tool_call", async (event, ctx) => {
    // Pass through if slow mode is disabled or no UI available
    if (!enabled || !ctx.hasUI) return;

    // Intercept write tool calls
    if (event.toolName === "write") {
      return await reviewWrite(event.toolCallId, event.input, ctx);
    }

    // Intercept edit tool calls
    if (event.toolName === "edit") {
      return await reviewEdit(event.toolCallId, event.input, ctx);
    }

    // All other tools pass through unchanged
  });

  // Hook into tool_result event — fires AFTER tool execution
  // Add a note when content was edited in slow mode
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled || !ctx.hasUI) return;

    const edited = editedCalls.get(event.toolCallId);
    if (!edited) return;

    // Clean up the tracking entry
    editedCalls.delete(event.toolCallId);

    // Calculate diff stats
    const originalLines = edited.original.split("\n").length;
    const editedLines = edited.edited.split("\n").length;
    const lineDiff = editedLines - originalLines;
    const lineDiffText =
      lineDiff > 0 ? `+${lineDiff} lines` : lineDiff < 0 ? `${lineDiff} lines` : "same line count";

    // Add a note to the result indicating content was edited
    const note = {
      type: "text" as const,
      text: `\n\n**Note:** Content was modified in slow mode review before writing (${lineDiffText}).`,
    };

    return {
      content: [...(event.content || []), note],
    };
  });

  ////----------------------------------------
  ///     Write & edit review
  //------------------------------------------

  /**
   * Resolves file path to be relative to cwd
   * This normalizes absolute/relative paths for consistent staging
   */
  function resolvePath(ctx: ExtensionContext, filePath: string) {
    return relative(ctx.cwd, resolve(ctx.cwd, filePath));
  }

  /**
   * Review handler for write tool calls (new files / overwrites).
   *
   * When the target file already exists the review shows a real diff against
   * the on-disk content, so an accidental clobber is obvious. For genuinely
   * new files the full proposed content is shown instead.
   */
  async function reviewWrite(
    toolCallId: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path as string;
    const content = input.content as string;

    // Skip if input is malformed
    if (!filePath || content == null) return;

    const relPath = resolvePath(ctx, filePath);
    const absPath = resolve(ctx.cwd, filePath);
    const existing = readFileIfPresent(absPath);

    // Stage the proposed content so the user can edit it before it lands
    const stage = stagePaths(relPath);
    writeFileSync(stage.oldPath, existing ?? "", "utf-8");
    writeFileSync(stage.newPath, content, "utf-8");

    // Emit event so other extensions can track when user approval is pending
    pi.events.emit("slow-mode:waiting", { toolCallId, toolName: "write", path: relPath });

    let approved = false;
    reviewLoop: while (true) {
      const proposed = readFileSync(stage.newPath, "utf-8");
      const isOverwrite = existing != null;

      const decision = await showReview(ctx, {
        operation: isOverwrite ? "OVERWRITE" : "NEW FILE",
        filePath: relPath,
        oldPath: stage.oldPath,
        newPath: stage.newPath,
        isDiff: isOverwrite,
        renderBody: (width, sideBySide) =>
          isOverwrite
            ? renderDiff({
                label: relPath,
                oldPath: stage.oldPath,
                newPath: stage.newPath,
                oldText: existing as string,
                newText: proposed,
                width,
                sideBySide,
              })
            : proposed,
        editable: true,
      });

      switch (decision) {
        case "approve":
          approved = true;
          break reviewLoop;
        case "reject":
          approved = false;
          break reviewLoop;
        case "edit":
          openExternalFile(stage.newPath);
          continue;
      }
    }

    if (approved) {
      const editedContent = readFileIfPresent(stage.newPath);
      if (editedContent != null && editedContent !== content) {
        input.content = editedContent;
        editedCalls.set(toolCallId, { original: content, edited: editedContent });
        ctx.ui.notify("Using edited content", "info");
      }
    }

    pi.events.emit("slow-mode:resolved", { toolCallId, toolName: "write", approved });

    discardStage(stage);

    if (!approved) {
      return { block: true, reason: "User rejected the write in slow mode review." };
    }

    // Approved: return undefined → tool proceeds with potentially modified content
  }

  /**
   * Review handler for edit tool calls (modifications to existing files).
   *
   * Two staging modes:
   *
   * - "file" (preferred): the real file is read from disk and every fragment is
   *   applied to it. The staged old/new files are complete documents, so the
   *   diff has genuine context and difftastic/delta can parse the language.
   *   Ctrl+E edits the resulting document; on approval the change is folded
   *   back into a single minimal `edits[]` entry.
   *
   * - "fragment" (fallback): used when the file is missing or a fragment does
   *   not match. Only the search/replace text is staged, as before.
   */
  async function reviewEdit(
    toolCallId: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ) {
    const filePath = input.path as string;
    if (!filePath) return;

    const fragments = readFragments(input);
    if (!fragments.length) return;

    const relPath = resolvePath(ctx, filePath);
    const absPath = resolve(ctx.cwd, filePath);

    // Try to rebuild the real before/after documents
    const original = readFileIfPresent(absPath);
    const applied = original != null ? applyFragments(original, fragments) : null;
    const mode: "file" | "fragment" = applied != null ? "file" : "fragment";

    const baseOld = mode === "file" ? (original as string) : fragments.map((f) => f.oldText).join("\n");
    const baseNew = mode === "file" ? (applied as string) : fragments.map((f) => f.newText).join("\n");

    const stage = stagePaths(relPath);
    writeFileSync(stage.oldPath, baseOld, "utf-8");
    writeFileSync(stage.newPath, baseNew, "utf-8");

    // Manual editing can only be mapped back onto the tool input when we have
    // the whole file, or when there is exactly one fragment to rewrite.
    const editable = mode === "file" || fragments.length === 1;

    // Emit event so other extensions can track when user approval is pending
    pi.events.emit("slow-mode:waiting", { toolCallId, toolName: "edit", path: relPath });

    // Review loop: show diff → user can approve, reject, or edit → repeat
    let approved = false;

    reviewLoop: while (true) {
      const currentOld = readFileSync(stage.oldPath, "utf-8");
      const currentNew = readFileSync(stage.newPath, "utf-8");

      const decision = await showReview(ctx, {
        operation: "EDIT",
        filePath: relPath,
        oldPath: stage.oldPath,
        newPath: stage.newPath,
        isDiff: true,
        subtitle:
          mode === "file"
            ? `${fragments.length} change${fragments.length === 1 ? "" : "s"} · full-file context`
            : `${fragments.length} change${fragments.length === 1 ? "" : "s"} · fragment only (file not readable)`,
        renderBody: (width, sideBySide) =>
          renderDiff({
            label: relPath,
            oldPath: stage.oldPath,
            newPath: stage.newPath,
            oldText: currentOld,
            newText: currentNew,
            width,
            sideBySide,
          }),
        editable,
      });

      switch (decision) {
        case "approve":
          approved = true;
          break reviewLoop;
        case "reject":
          approved = false;
          break reviewLoop;
        case "edit":
          // Open the proposed result in the user's editor, then loop back
          openExternalFile(stage.newPath);
          continue;
      }
    }

    if (approved) {
      const editedNew = readFileIfPresent(stage.newPath);
      if (editedNew != null && editedNew !== baseNew) {
        applyManualEdit(input, fragments, mode, baseOld, editedNew, ctx);
        editedCalls.set(toolCallId, { original: baseNew, edited: editedNew });
      }
    }

    pi.events.emit("slow-mode:resolved", { toolCallId, toolName: "edit", approved });

    discardStage(stage);

    if (!approved) {
      return { block: true, reason: "User rejected the edit in slow mode review." };
    }

    // Approved: return undefined → tool proceeds with potentially modified content
  }

  /**
   * Normalise the edit tool input into a list of search/replace fragments.
   * Supports both the modern `edits[]` array and legacy top-level oldText/newText.
   */
  function readFragments(input: Record<string, unknown>): EditFragment[] {
    const edits = input.edits as EditFragment[] | undefined;
    if (Array.isArray(edits) && edits.length) {
      return edits.filter((e) => e && typeof e.oldText === "string" && typeof e.newText === "string");
    }
    const oldText = input.oldText as string | undefined;
    const newText = input.newText as string | undefined;
    if (typeof oldText === "string" && typeof newText === "string") {
      return [{ oldText, newText }];
    }
    return [];
  }

  /**
   * Apply fragments sequentially to a document.
   * Returns null if any fragment cannot be located, in which case the caller
   * falls back to fragment-only staging.
   */
  function applyFragments(content: string, fragments: EditFragment[]): string | null {
    let result = content;
    for (const fragment of fragments) {
      if (fragment.oldText === "") return null;
      const index = result.indexOf(fragment.oldText);
      if (index === -1) return null;
      result =
        result.slice(0, index) + fragment.newText + result.slice(index + fragment.oldText.length);
    }
    return result === content ? null : result;
  }

  /**
   * Fold a manually edited document back into the tool input.
   */
  function applyManualEdit(
    input: Record<string, unknown>,
    fragments: EditFragment[],
    mode: "file" | "fragment",
    baseOld: string,
    editedNew: string,
    ctx: ExtensionContext,
  ) {
    if (mode === "file") {
      const minimal = computeMinimalEdit(baseOld, editedNew);
      if (!minimal) {
        ctx.ui.notify("Manual edit produced no change — using original proposal", "warning");
        return;
      }
      // Replace the whole batch with one equivalent, minimal replacement
      delete input.oldText;
      delete input.newText;
      input.edits = [minimal];
      ctx.ui.notify("Using edited content", "info");
      return;
    }

    // Fragment mode: only unambiguous when there is a single fragment
    if (fragments.length !== 1) {
      ctx.ui.notify(
        "Cannot map manual edits back onto a multi-edit call without file context — using original proposal",
        "warning",
      );
      return;
    }

    if (Array.isArray(input.edits) && input.edits.length === 1) {
      (input.edits as EditFragment[])[0].newText = editedNew;
    } else {
      input.newText = editedNew;
    }
    ctx.ui.notify("Using edited content", "info");
  }

  /**
   * Reduce a whole-document rewrite to the smallest unique search/replace pair.
   *
   * Trims the common prefix/suffix lines, then grows context outward until the
   * search text occurs exactly once in the original document.
   */
  function computeMinimalEdit(oldText: string, newText: string): EditFragment | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
      start++;
    }

    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;
    while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
      oldEnd--;
      newEnd--;
    }

    for (let context = 0; ; context++) {
      const from = Math.max(0, start - context);
      const toOld = Math.min(oldLines.length - 1, oldEnd + context);
      const toNew = Math.min(newLines.length - 1, newEnd + context);
      const wholeFile = from === 0 && toOld === oldLines.length - 1;

      const candidateOld = from > toOld ? "" : oldLines.slice(from, toOld + 1).join("\n");
      const candidateNew = from > toNew ? "" : newLines.slice(from, toNew + 1).join("\n");

      if (candidateOld !== "" && countOccurrences(oldText, candidateOld) === 1) {
        return { oldText: candidateOld, newText: candidateNew };
      }
      if (wholeFile) {
        return { oldText, newText };
      }
    }
  }

  function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count++;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  }

  /**
   * Allocate staged old/new paths under a private directory.
   *
   * Both files keep the original name and extension — they sit in sibling
   * `old/` and `new/` directories rather than being renamed — so editors and
   * syntax-aware diff tools detect the language, and difftastic reports a
   * recognisable name.
   */
  function stagePaths(relPath: string) {
    const base = basename(relPath);
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const root = join(stagingRoot(), `stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(root, "old"), { recursive: true });
    mkdirSync(join(root, "new"), { recursive: true });
    return {
      root,
      oldPath: join(root, "old", `${stem}${ext}`),
      newPath: join(root, "new", `${stem}${ext}`),
    };
  }

  /** Remove a staging directory and everything in it. */
  function discardStage(stage: { root: string }) {
    try {
      rmSync(stage.root, { recursive: true, force: true });
    } catch {
      // Best-effort — the whole tmpDir goes on session shutdown anyway
    }
  }

  function readFileIfPresent(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }

  ////----------------------------------------
  ///     Review UI
  //------------------------------------------

  /**
   * Result from the review UI: approve, reject, or edit
   */
  type ReviewResult = "approve" | "reject" | "edit";

  interface ReviewOptions {
    /** Label shown in the header */
    operation: "NEW FILE" | "OVERWRITE" | "EDIT";
    /** Relative path to the file */
    filePath: string;
    /** Optional second header line with extra detail */
    subtitle?: string;
    /** Produces the review body for a given viewport width and layout */
    renderBody: (width: number, sideBySide: boolean) => string;
    /** Whether the body is a diff (enables layout toggle + context controls) */
    isDiff: boolean;
    /** Staged old document (for the external pager view) */
    oldPath: string;
    /** Staged new document (edited by Ctrl+E) */
    newPath: string;
    /** Allow Ctrl+E to open the proposed result in an editor */
    editable?: boolean;
  }

  /**
   * Show the interactive review gate.
   *
   * @returns "approve", "reject", or "edit" (caller opens the editor and re-shows)
   */
  async function showReview(ctx: ExtensionContext, opts: ReviewOptions): Promise<ReviewResult> {
    const { matchesKey, Key } = await import("@mariozechner/pi-tui");

    return ctx.ui.custom<ReviewResult>((tui, theme, _kb, done) => {
      // Remember the app TUI so external processes can suspend it, including
      // after this component has been dismissed (Ctrl+E flow).
      activeTui = tui;

      let scrollOffset = 0;
      let lastGPress = 0;

      // Layout: null until the first render, when the real viewport width is
      // known. Two columns are only worth it if each one can hold a code line.
      let sideBySideOverride: boolean | null = null;

      // Rendered body cache, keyed by "width:layout:context:backend"
      let bodyCache: { key: string; lines: string[] } | null = null;
      let cachedLines: string[] | undefined;
      let cachedWidth = -1;

      function renderWidth() {
        return cachedWidth > 0 ? cachedWidth : (tui.terminal?.columns ?? 100);
      }

      function sideBySide(width = renderWidth()) {
        if (!opts.isDiff || !backendSupportsSideBySide()) return false;
        return sideBySideOverride ?? width >= 140;
      }

      /** Rows available for the scrollable body */
      function viewportRows() {
        const rows = tui.terminal?.rows ?? 40;
        // Leave room for header, hints, separators and the editor below
        return Math.max(8, Math.min(40, rows - 14));
      }

      function bodyLines(width: number): string[] {
        const available = Math.max(40, width - 2);
        const layout = sideBySide(width);
        const key = `${available}:${layout}:${contextLines()}:${selectBackend()}`;
        if (bodyCache?.key === key) return bodyCache.lines;
        let text: string;
        try {
          text = opts.renderBody(available, layout);
        } catch (err) {
          text = `Failed to render diff: ${err instanceof Error ? err.message : String(err)}`;
        }
        const lines = dropFileHeader(stripEraseSequences(text)).split("\n");
        bodyCache = { key, lines };
        return lines;
      }

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function clampScroll(offset: number, total: number) {
        const maxScroll = Math.max(0, total - viewportRows());
        scrollOffset = Math.max(0, Math.min(maxScroll, offset));
      }

      /** Current total line count, using the last known width */
      function totalLines() {
        return bodyLines(renderWidth()).length;
      }

      function handleInput(data: string) {
        // Approve change
        if (matchesKey(data, Key.enter)) {
          done("approve");
          return;
        }

        // Reject change
        if (matchesKey(data, Key.escape)) {
          done("reject");
          return;
        }

        // Edit the proposed result in $VISUAL/$EDITOR
        if (opts.editable && matchesKey(data, Key.ctrl("e"))) {
          done("edit");
          return;
        }

        // Open the full diff in a pager (scrollable, no height limit)
        if (matchesKey(data, Key.ctrl("o"))) {
          openInPager(bodyLines(renderWidth()).join("\n"), opts.filePath);
          refresh();
          return;
        }

        // Toggle side-by-side / inline layout, where the backend can do it
        if (opts.isDiff && data === "s" && backendSupportsSideBySide()) {
          sideBySideOverride = !sideBySide();
          scrollOffset = 0;
          refresh();
          return;
        }

        // Adjust context lines
        if (opts.isDiff && (data === "[" || data === "]")) {
          setContextLines(contextLines() + (data === "]" ? 1 : -1));
          refresh();
          return;
        }

        // Cycle the diff backend. Line counts differ wildly between a
        // structural and a unified diff, so the scroll position is reset.
        if (opts.isDiff && data === "b") {
          cycleBackend();
          scrollOffset = 0;
          refresh();
          return;
        }

        if (data === "k" || matchesKey(data, Key.up)) {
          clampScroll(scrollOffset - 1, totalLines());
          refresh();
          return;
        }

        if (data === "j" || matchesKey(data, Key.down)) {
          clampScroll(scrollOffset + 1, totalLines());
          refresh();
          return;
        }

        if (data === "u" || matchesKey(data, Key.pageUp)) {
          clampScroll(scrollOffset - viewportRows(), totalLines());
          refresh();
          return;
        }

        if (data === "d" || matchesKey(data, Key.pageDown)) {
          clampScroll(scrollOffset + viewportRows(), totalLines());
          refresh();
          return;
        }

        // gg — go to top
        if (data === "g") {
          const now = Date.now();
          if (now - lastGPress < 500) {
            scrollOffset = 0;
            refresh();
            lastGPress = 0;
          } else {
            lastGPress = now;
          }
          return;
        }

        // G — go to bottom
        if (data === "G") {
          clampScroll(Number.MAX_SAFE_INTEGER, totalLines());
          refresh();
          return;
        }
      }

      function render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;
        cachedWidth = width;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));

        const opLabel =
          opts.operation === "NEW FILE"
            ? theme.fg("warning", " NEW FILE")
            : opts.operation === "OVERWRITE"
              ? theme.fg("warning", " OVERWRITE")
              : theme.fg("accent", " EDIT");
        const layout =
          opts.isDiff && backendSupportsSideBySide()
            ? theme.fg("dim", sideBySide(width) ? "  side-by-side" : "  inline")
            : "";
        add(`${opLabel}${layout}  ${theme.fg("dim", diffBackendLabel())}`);
        add(` ${theme.fg("accent", opts.filePath)}`);
        if (opts.subtitle) add(` ${theme.fg("dim", opts.subtitle)}`);
        lines.push("");

        const body = bodyLines(width);
        const rows = viewportRows();
        clampScroll(scrollOffset, body.length);
        const visible = body.slice(scrollOffset, scrollOffset + rows);

        const colorized = /\x1b\[[0-9;]*m/.test(body.join("\n"));
        for (const rawLine of visible) {
          const line = rawLine.replace(/\t/g, "    ");
          if (colorized) {
            // Backend already coloured the output — keep its ANSI codes, but
            // reset at end of line so background colours cannot bleed.
            add(` ${line}\x1b[0m`);
          } else if (opts.isDiff) {
            add(` ${colorPlainDiffLine(theme, line)}`);
          } else {
            add(` ${theme.fg("text", line)}`);
          }
        }

        if (body.length > rows) {
          const end = Math.min(scrollOffset + rows, body.length);
          add(theme.fg("dim", ` (lines ${scrollOffset + 1}–${end} of ${body.length})`));
        }

        lines.push("");

        const hints = ["Enter approve", "Esc reject"];
        if (opts.editable) hints.push("Ctrl+E edit");
        hints.push("Ctrl+O pager");
        if (opts.isDiff) {
          if (backendSupportsSideBySide()) hints.push("s layout");
          hints.push("[/] context", "b backend");
        }
        hints.push("j/k u/d gg/G scroll");
        for (const row of packHints(hints, width - 1)) {
          add(theme.fg("dim", ` ${row}`));
        }

        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
          bodyCache = null;
        },
        handleInput,
      };
    });
  }

  /** Colour a plain unified-diff line using the active theme. */
  function colorPlainDiffLine(theme: ExtensionContext["ui"]["theme"], line: string): string {
    if (line.startsWith("---") || line.startsWith("+++")) return theme.fg("dim", line);
    if (line.startsWith("@@")) return theme.fg("accent", line);
    if (line.startsWith("+")) return theme.fg("success", line);
    if (line.startsWith("-")) return theme.fg("error", line);
    return theme.fg("text", line);
  }

  /**
   * Remove erase-in-line sequences (CSI K) emitted by delta.
   *
   * They tell the terminal to clear the rest of the physical line, which
   * corrupts pi's differential renderer when the diff is embedded in the chat
   * transcript rather than printed to a raw screen.
   */
  function stripEraseSequences(text: string): string {
    return text.replace(/\x1b\[[0-9]*K/g, "");
  }

  /**
   * Drop the `--- a/path` / `+++ b/path` banner from a unified diff.
   *
   * The paths are still fed to delta (it derives the language from the
   * extension), but the review header already names the file, so repeating it
   * costs two of the few rows the inline window has.
   */
  function dropFileHeader(text: string): string {
    const lines = text.split("\n");
    while (lines.length && /^(---|\+\+\+) /.test(stripAnsi(lines[0]))) {
      lines.shift();
    }
    return lines.join("\n");
  }

  /**
   * Lay key hints out over as few lines as fit the viewport, so a narrow
   * terminal loses a row instead of silently truncating the last hints.
   */
  function packHints(hints: string[], width: number): string[] {
    const rows: string[] = [];
    let current = "";
    for (const hint of hints) {
      const candidate = current ? `${current} • ${hint}` : hint;
      if (current && candidate.length > width) {
        rows.push(current);
        current = hint;
      } else {
        current = candidate;
      }
    }
    if (current) rows.push(current);
    return rows;
  }

  ////----------------------------------------
  ///     Terminal handover
  //------------------------------------------

  /**
   * Run a callback with the pi TUI suspended.
   *
   * pi keeps stdin in raw mode with its own data handler attached. Spawning a
   * child with `stdio: "inherit"` is not enough — pi keeps consuming keystrokes,
   * so pagers and editors receive nothing while pi scrolls behind them. Stopping
   * the TUI releases raw mode and detaches the handler, mirroring what pi does
   * for its own Ctrl+G external editor.
   */
  function withSuspendedTui<T>(fn: () => T): T {
    const tui = activeTui;
    if (!tui) return fn();

    try {
      tui.stop();
    } catch {
      // If suspending fails, still run the callback — degraded but not broken
    }

    try {
      return fn();
    } finally {
      try {
        tui.start();
        // External tools use the alternate screen; force a full repaint
        tui.requestRender(true);
      } catch {
        // Best-effort restore
      }
    }
  }

  /**
   * Spawn an interactive child process with the TUI suspended.
   *
   * `env` is passed explicitly here and at every other spawn site. Bun
   * snapshots the environment at startup and does not pick up later
   * `process.env` mutations for child processes or for resolving the command
   * on PATH — and mutating `process.env` is exactly what the direnv extension
   * does, PATH included. Without this, a difftastic or editor provided by a
   * direnv-managed shell is invisible to slow mode.
   */
  function runInteractive(cmd: string, args: string[]) {
    withSuspendedTui(() => {
      try {
        spawnSync(cmd, args, { stdio: "inherit", env: process.env });
      } catch {
        // Tool missing or failed to start — stay in the inline review
      }
    });
  }

  /**
   * Open the user's preferred editor on a single file.
   * Honours multi-word commands such as `code --wait`.
   */
  function openExternalFile(filePath: string) {
    const configured = process.env.VISUAL || process.env.EDITOR || "nano";
    const [cmd, ...args] = configured.split(/\s+/).filter(Boolean);
    if (!cmd) return;
    runInteractive(cmd, [...args, filePath]);
  }

  /**
   * Show pre-rendered (already coloured) text in a pager.
   *
   * The diff is rendered by slow mode itself and only piped through a pager for
   * scrolling, which keeps the pager view identical to the inline view. `$PAGER`
   * is deliberately ignored — it is commonly set to something like
   * `bat --paging=always`, which would re-decorate content that is already
   * fully styled.
   */
  function openInPager(text: string, label: string) {
    const file = join(stagingRoot(), `view-${Date.now()}.diff`);
    try {
      writeFileSync(file, `${text}\n`, "utf-8");
      if (toolAvailable("less")) {
        runInteractive("less", ["-R", "--tilde", `--prompt=${label} (q to close)`, file]);
      } else if (toolAvailable("more")) {
        runInteractive("more", [file]);
      } else {
        withSuspendedTui(() => {
          process.stdout.write(`${text}\n`);
        });
      }
    } catch {
      // Best-effort — fall back to the inline view
    } finally {
      cleanup(file);
    }
  }

  ////----------------------------------------
  ///     Diff rendering
  //------------------------------------------

  const toolCache = new Map<string, boolean>();

  /** Check (and cache) whether a command exists on PATH. */
  function toolAvailable(cmd: string): boolean {
    const cached = toolCache.get(cmd);
    if (cached !== undefined) return cached;
    let found = false;
    try {
      const probe = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
        stdio: "ignore",
        env: process.env,
      });
      found = probe.status === 0;
    } catch {
      found = false;
    }
    toolCache.set(cmd, found);
    return found;
  }

  // Context lines around each change, adjustable at review time with [ and ]
  let userContextLines = clampContext(Number.parseInt(process.env.PI_SLOW_MODE_CONTEXT ?? "", 10));

  function clampContext(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.min(50, value)) : 3;
  }

  function contextLines() {
    return userContextLines;
  }

  function setContextLines(value: number) {
    userContextLines = clampContext(value);
  }

  /** Diff renderers, in order of preference. */
  type DiffBackend = "difft" | "delta" | "builtin";

  /** Which backend slow mode will use, for the header label. */
  function diffBackendLabel(): string {
    const backend = selectBackend();
    return backend === "builtin" ? "builtin diff" : backend;
  }

  // Backend picked live with `b` during a review. Null means "follow
  // PI_SLOW_MODE_DIFF, else auto-detect". Persists for the session, so a
  // preference expressed once carries into the next review.
  let backendOverride: DiffBackend | null = null;

  /**
   * Backends usable right now: the external ones actually on PATH, plus the
   * built-in, which is always last and always present.
   */
  function availableBackends(): DiffBackend[] {
    const backends: DiffBackend[] = [];
    if (toolAvailable("difft")) backends.push("difft");
    if (toolAvailable("delta")) backends.push("delta");
    backends.push("builtin");
    return backends;
  }

  /**
   * Advance to the next installed backend, wrapping around. With neither
   * difft nor delta installed the list is just ["builtin"] and this is a
   * no-op — there is nothing to cycle to.
   */
  function cycleBackend(): DiffBackend {
    const backends = availableBackends();
    const index = backends.indexOf(selectBackend());
    backendOverride = backends[(index + 1) % backends.length]!;
    return backendOverride;
  }

  /**
   * Whether the active backend can render two columns.
   *
   * The built-in Myers renderer emits a unified diff and nothing else. Rather
   * than let `s` toggle a header label over an unchanged inline diff, the key
   * and its hint are withdrawn while the built-in is in use.
   */
  function backendSupportsSideBySide(): boolean {
    return selectBackend() !== "builtin";
  }

  function selectBackend(): DiffBackend {
    if (backendOverride) return backendOverride;
    const preference = (process.env.PI_SLOW_MODE_DIFF ?? "auto").toLowerCase();
    if (preference === "builtin") return "builtin";
    if (preference === "difft") return toolAvailable("difft") ? "difft" : "builtin";
    if (preference === "delta") return toolAvailable("delta") ? "delta" : "builtin";
    if (toolAvailable("difft")) return "difft";
    if (toolAvailable("delta")) return "delta";
    return "builtin";
  }

  interface DiffRequest {
    label: string;
    oldPath: string;
    newPath: string;
    oldText: string;
    newText: string;
    width: number;
    sideBySide: boolean;
  }

  /**
   * Render a diff using the best available backend.
   *
   * difftastic is preferred because it diffs parsed syntax trees rather than
   * lines: reindentation, wrapped arguments and moved braces stop showing up as
   * changes, and only the tokens that actually differ are highlighted.
   */
  function renderDiff(req: DiffRequest): string {
    const backend = selectBackend();

    if (backend === "difft") {
      const out = renderWithDifft(req);
      if (out) return out;
    }

    const unified = generateUnifiedDiff(req.label, req.oldText, req.newText, contextLines());

    if (backend === "difft" || backend === "delta") {
      if (toolAvailable("delta")) {
        const out = renderWithDelta(unified, req.width, req.sideBySide);
        if (out) return out;
      }
    }

    return unified;
  }

  /**
   * Structural diff via difftastic.
   *
   * The staged files keep the original extension, so difft picks the right
   * tree-sitter grammar. Its own header line is dropped because the review UI
   * already shows the real path; the detected language is folded back in.
   */
  function renderWithDifft(req: DiffRequest): string | null {
    const args = [
      "--color",
      "always",
      "--display",
      req.sideBySide ? "side-by-side" : "inline",
      "--width",
      String(Math.max(40, req.width)),
      "--context",
      String(contextLines()),
      "--tab-width",
      "4",
      "--background",
      process.env.DFT_BACKGROUND ?? "dark",
      req.oldPath,
      req.newPath,
    ];

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("difft", args, {
        encoding: "utf-8",
        env: process.env,
        timeout: 10_000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      return null;
    }

    if (result.error || result.status !== 0) return null;

    const output = (result.stdout as unknown as string) ?? "";
    const lines = output.replace(/\s+$/, "").split("\n");
    if (!lines.length) return null;

    // Drop difftastic's "<staged path> --- <Language>" banner, keeping language
    const banner = lines[0];
    const language = /---\s*(.+?)\s*$/.exec(stripAnsi(banner))?.[1];
    const body = lines.slice(1);
    while (body.length && body[0].trim() === "") body.shift();

    if (!body.length) return language ? `No syntactic changes (${language})` : "No changes";
    return body.join("\n");
  }

  /**
   * Unified diff with delta's syntax and word-level highlighting.
   *
   * Inline passes `--color-only`, which leaves the output line-for-line
   * identical to the diff fed in: delta recolours and nothing else.
   *
   * Side-by-side cannot use that flag — splitting into columns *is* a
   * structural rewrite, and `--color-only` makes delta ignore
   * `--side-by-side` entirely. Dropping it also turns delta's own chrome back
   * on, so the file banner is omitted (the review header already names the
   * file) and the boxed hunk marker is reduced to a bare line number, which
   * keeps multi-hunk diffs navigable without spending three rows per hunk.
   */
  function renderWithDelta(unifiedDiff: string, width: number, sideBySide: boolean): string | null {
    const args = [
      "--no-gitconfig",
      "--paging",
      "never",
      "--tabs",
      "4",
      "--width",
      String(Math.max(40, width)),
    ];

    if (sideBySide) {
      args.push(
        "--side-by-side",
        "--file-style",
        "omit",
        "--hunk-header-decoration-style",
        "omit",
      );
    } else {
      args.push("--color-only");
    }

    try {
      const result = spawnSync("delta", args, {
        input: unifiedDiff,
        encoding: "utf-8",
        env: process.env,
        timeout: 5_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) return null;
      const output = (result.stdout as unknown as string) ?? "";
      if (!output.trim()) return null;

      // With the file banner omitted delta still opens on a blank line
      const lines = output.replace(/\s+$/, "").split("\n");
      while (lines.length && stripAnsi(lines[0]).trim() === "") lines.shift();
      return lines.length ? lines.join("\n") : null;
    } catch {
      return null;
    }
  }

  function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
  }

  ////----------------------------------------
  ///     Diff generation (Myers algorithm)
  //------------------------------------------

  /**
   * Generate a unified diff using the Myers diff algorithm.
   *
   * Zero-dependency fallback used when no external diff tool is available, and
   * as the input for delta.
   *
   * @param filePath - Relative file path (used in --- / +++ headers)
   * @param oldText - Original text
   * @param newText - Modified text
   * @param contextLines - Number of context lines around changes (default: 3)
   * @returns Unified diff string
   */
  function generateUnifiedDiff(
    filePath: string,
    oldText: string,
    newText: string,
    contextLines = 3,
  ): string {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const edits = myersDiff(oldLines, newLines);
    const hunks = buildHunks(edits, contextLines);

    const out: string[] = [];
    out.push(`--- a/${filePath}`);
    out.push(`+++ b/${filePath}`);

    for (const hunk of hunks) {
      out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
      for (const line of hunk.lines) {
        out.push(line);
      }
    }

    return out.join("\n");
  }

  /**
   * Edit operation in a diff: keep, insert, or delete a line.
   */
  type Edit =
    | { type: "keep"; line: string }
    | { type: "insert"; line: string }
    | { type: "delete"; line: string };

  /**
   * Myers diff algorithm (linear-space variant).
   *
   * Computes the shortest edit script (SES) between two arrays of lines.
   * Time: O((N+M)D) where D is the edit distance.
   * Space: O((N+M)D) for the trace (acceptable for code diffs).
   *
   * Reference: Eugene W. Myers, "An O(ND) Difference Algorithm and Its
   * Variations", Algorithmica 1(2), 1986.
   */
  function myersDiff(oldLines: string[], newLines: string[]): Edit[] {
    const n = oldLines.length;
    const m = newLines.length;
    const max = n + m;

    // V[k] = furthest x-position reached on diagonal k
    // Diagonals range from -max..+max, offset by max for array indexing
    const size = 2 * max + 1;
    const v = new Int32Array(size);
    v[max + 1] = 0;

    // Store each V snapshot to reconstruct the path
    const trace: Int32Array[] = [];

    outer: for (let d = 0; d <= max; d++) {
      // Save current state before modification
      trace.push(v.slice());

      for (let k = -d; k <= d; k += 2) {
        const kIdx = k + max;

        // Decide whether to move down (insert) or right (delete)
        let x: number;
        if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
          x = v[kIdx + 1]; // move down: take x from diagonal k+1
        } else {
          x = v[kIdx - 1] + 1; // move right: take x from diagonal k-1 and advance
        }
        let y = x - k;

        // Follow the diagonal (matching lines)
        while (x < n && y < m && oldLines[x] === newLines[y]) {
          x++;
          y++;
        }

        v[kIdx] = x;

        // Reached the end of both sequences
        if (x >= n && y >= m) {
          break outer;
        }
      }
    }

    // Backtrack through the trace to reconstruct the edit script
    const edits: Edit[] = [];
    let x = n;
    let y = m;

    for (let d = trace.length - 1; d >= 0; d--) {
      const prev = trace[d];
      const k = x - y;
      const kIdx = k + max;

      // Determine which diagonal we came from
      let prevK: number;
      if (k === -d || (k !== d && prev[kIdx - 1] < prev[kIdx + 1])) {
        prevK = k + 1; // came from above (insert)
      } else {
        prevK = k - 1; // came from left (delete)
      }

      const prevX = prev[prevK + max];
      const prevY = prevX - prevK;

      // Diagonal moves (matching lines) — emit keeps in reverse
      while (x > prevX && y > prevY) {
        x--;
        y--;
        edits.push({ type: "keep", line: oldLines[x] });
      }

      if (d > 0) {
        if (x === prevX) {
          // Vertical move: insert from new
          y--;
          edits.push({ type: "insert", line: newLines[y] });
        } else {
          // Horizontal move: delete from old
          x--;
          edits.push({ type: "delete", line: oldLines[x] });
        }
      }
    }

    edits.reverse();
    return edits;
  }

  /**
   * A hunk in a unified diff.
   */
  interface Hunk {
    oldStart: number; // 1-based start line in old file
    oldCount: number; // number of old-file lines in hunk
    newStart: number; // 1-based start line in new file
    newCount: number; // number of new-file lines in hunk
    lines: string[]; // prefixed lines (" ", "+", "-")
  }

  /**
   * Group edit operations into unified diff hunks with context lines.
   *
   * Adjacent changes within (2 * contextLines) of each other are merged
   * into a single hunk, matching standard unified diff behavior.
   */
  function buildHunks(edits: Edit[], contextLines: number): Hunk[] {
    if (edits.length === 0) return [];

    // Find indices of all change operations (insert or delete)
    const changeIndices: number[] = [];
    for (let i = 0; i < edits.length; i++) {
      if (edits[i].type !== "keep") {
        changeIndices.push(i);
      }
    }

    if (changeIndices.length === 0) return [];

    // Group changes that are close enough to share context
    const groups: { start: number; end: number }[] = [];
    let groupStart = changeIndices[0];
    let groupEnd = changeIndices[0];

    for (let i = 1; i < changeIndices.length; i++) {
      // If gap between changes is <= 2*contextLines, merge into same group
      if (changeIndices[i] - groupEnd <= 2 * contextLines) {
        groupEnd = changeIndices[i];
      } else {
        groups.push({ start: groupStart, end: groupEnd });
        groupStart = changeIndices[i];
        groupEnd = changeIndices[i];
      }
    }
    groups.push({ start: groupStart, end: groupEnd });

    // Convert groups into hunks
    const hunks: Hunk[] = [];

    for (const group of groups) {
      // Expand to include context lines
      const hunkStart = Math.max(0, group.start - contextLines);
      const hunkEnd = Math.min(edits.length - 1, group.end + contextLines);

      const lines: string[] = [];
      let oldCount = 0;
      let newCount = 0;

      // Compute 1-based starting line numbers
      let oldLine = 1;
      let newLine = 1;
      for (let i = 0; i < hunkStart; i++) {
        if (edits[i].type === "keep" || edits[i].type === "delete") oldLine++;
        if (edits[i].type === "keep" || edits[i].type === "insert") newLine++;
      }

      for (let i = hunkStart; i <= hunkEnd; i++) {
        const edit = edits[i];
        switch (edit.type) {
          case "keep":
            lines.push(` ${edit.line}`);
            oldCount++;
            newCount++;
            break;
          case "delete":
            lines.push(`-${edit.line}`);
            oldCount++;
            break;
          case "insert":
            lines.push(`+${edit.line}`);
            newCount++;
            break;
        }
      }

      hunks.push({
        oldStart: oldLine,
        oldCount,
        newStart: newLine,
        newCount,
        lines,
      });
    }

    return hunks;
  }

  ////----------------------------------------
  ///     Helpers
  //------------------------------------------

  /**
   * Delete a scratch file, ignoring errors.
   */
  function cleanup(path: string) {
    try {
      unlinkSync(path);
    } catch {
      // Ignore — tmp cleanup is best-effort
    }
  }
}

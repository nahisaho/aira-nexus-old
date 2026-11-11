"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  baseKeymap,
  selectAll,
  setBlockType,
  toggleMark,
} from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType } from "prosemirror-model";
import {
  journalBudget,
  journalBytes,
  journalSchema,
  journalSource,
  parseJournal,
  type JournalMode,
} from "../lib/journal-markdown";
import { useText } from "./appearance";
import { ScientificView } from "./scientific-view";
import { Button } from "./ui/button";

type Cell = { id: string; source: string };
type Preview = { key: number; host: HTMLElement; source: string };
/** @id CODE-JOURNAL-INPUT-RULE @implements REQ-MARKDOWN-005 */
function markRule(pattern: RegExp, mark: MarkType) {
  return new InputRule(pattern, (state, match, start, end) => {
    const from = start + match[0].length - match[1].length;
    return state.tr
      .delete(from, end)
      .insertText(match[2], from)
      .addMark(from, from + match[2].length, mark.create())
      .removeStoredMark(mark);
  });
}
/** @id CODE-JOURNAL-CELL @implements REQ-MARKDOWN-004 REQ-MARKDOWN-005 */
function JournalCell({
  cell,
  mode,
  disabled,
  projectId,
  scientific,
  onChange,
  register,
  onFocus,
  onComposition,
}: {
  cell: Cell;
  mode: JournalMode;
  disabled: boolean;
  projectId: string;
  scientific: boolean;
  onChange: (id: string, source: string) => void;
  register: (id: string, view?: EditorView) => void;
  onFocus: (id: string) => void;
  onComposition: (id: string, value: boolean) => void;
}) {
  const { t } = useText();
  const sourceLabel = `${t("ソース")} ${cell.id}`;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const latest = useRef({ cell, disabled, onChange, onFocus, onComposition });
  const emitted = useRef(cell.source);
  const prefix = useRef("");
  const [initial] = useState(() => {
    try {
      return { parsed: parseJournal(cell.source, mode), error: undefined };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { parsed: undefined, error: error.message };
    }
  });
  const [error, setError] = useState<string | undefined>(initial.error);
  const [previews, setPreviews] = useState<Preview[]>([]);
  useLayoutEffect(() => {
    latest.current = { cell, disabled, onChange, onFocus, onComposition };
    view.current?.setProps({ editable: () => !disabled });
  });
  useLayoutEffect(() => {
    let sequence = 0;
    let frame = 0;
    const parsed = initial.parsed;
    if (!parsed) return;
    emitted.current = latest.current.cell.source;
    prefix.current = parsed.prefix;
    const plugins = [
      new Plugin({
        filterTransaction(tr, state) {
          if (!tr.docChanged) return true;
          if (latest.current.disabled) return false;
          const bytes = journalBytes(
            journalSource(tr.doc, prefix.current, mode),
          );
          const oldBytes = journalBytes(
            journalSource(state.doc, prefix.current, mode),
          );
          if (bytes > journalBudget && !(mode === "text" && bytes < oldBytes)) {
            setError("JOURNAL_SOURCE_BUDGET_EXCEEDED");
            return false;
          }
          return true;
        },
      }),
      history(),
      ...(mode === "rendered"
        ? [
            inputRules({
              rules: [
                textblockTypeInputRule(
                  /^(#{1,3})\s$/,
                  journalSchema.nodes.heading,
                  (match) => ({ level: match[1].length }),
                ),
                markRule(
                  /(?:^|[^*])(\*\*([^*]+)\*\*)$/,
                  journalSchema.marks.strong,
                ),
                markRule(
                  /(?:^|[^\p{L}\p{N}_])(__([^_]+)__)$/u,
                  journalSchema.marks.strong,
                ),
                markRule(/(?:^|[^*])(\*([^*]+)\*)$/, journalSchema.marks.em),
                markRule(
                  /(?:^|[^\p{L}\p{N}_])(_([^_]+)_)$/u,
                  journalSchema.marks.em,
                ),
                markRule(/(~~([^~]+)~~)$/, journalSchema.marks.strike),
              ],
            }),
          ]
        : []),
      keymap({
        "Mod-z": undo,
        "Mod-Shift-z": redo,
        "Mod-y": redo,
        ...(mode === "rendered"
          ? baseKeymap
          : {
              "Mod-a": selectAll,
              Enter: (state, dispatch) => {
                dispatch?.(state.tr.insertText("\n"));
                return true;
              },
            }),
      }),
    ];
    const editor = new EditorView(host.current!, {
      state: EditorState.create({ doc: parsed.doc, plugins }),
      editable: () => !latest.current.disabled,
      attributes: {
        role: "textbox",
        "aria-label": sourceLabel,
        "aria-multiline": "true",
      },
      dispatchTransaction(tr) {
        const result = editor.state.applyTransaction(tr);
        editor.updateState(result.state);
        if (result.transactions.some((item) => item.docChanged)) {
          const source = journalSource(result.state.doc, prefix.current, mode);
          emitted.current = source;
          setError(undefined);
          latest.current.onChange(cell.id, source);
        }
      },
      handlePaste(editor, event) {
        event.preventDefault();
        if (!event.clipboardData?.types.includes("text/plain")) {
          setError("JOURNAL_PLAIN_TEXT_REQUIRED");
          return true;
        }
        editor.dispatch(
          editor.state.tr.insertText(event.clipboardData.getData("text/plain")),
        );
        return true;
      },
      handleDrop(editor, event) {
        event.preventDefault();
        if (
          event.dataTransfer?.files.length ||
          !event.dataTransfer?.types.includes("text/plain")
        ) {
          setError("JOURNAL_PLAIN_TEXT_REQUIRED");
          return true;
        }
        const position = editor.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!position) {
          setError("JOURNAL_DROP_TARGET_REQUIRED");
          return true;
        }
        editor.dispatch(
          editor.state.tr.insertText(
            event.dataTransfer.getData("text/plain"),
            position.pos,
          ),
        );
        return true;
      },
      handleDOMEvents: {
        focus: () => {
          latest.current.onFocus(cell.id);
          return false;
        },
        compositionstart: () => {
          latest.current.onComposition(cell.id, true);
          return false;
        },
        compositionend: () => {
          frame = requestAnimationFrame(() =>
            latest.current.onComposition(cell.id, false),
          );
          return false;
        },
      },
      nodeViews: {
        raw_block(node) {
          const dom = document.createElement("div");
          dom.contentEditable = "false";
          dom.className = "journal-preview";
          const key = ++sequence;
          const source: unknown = node.attrs.source;
          if (typeof source !== "string")
            throw new Error("JOURNAL_INVALID_PREVIEW");
          setPreviews((items) => [...items, { key, host: dom, source }]);
          return {
            dom,
            ignoreMutation: () => true,
            selectNode: () => dom.classList.add("ProseMirror-selectednode"),
            deselectNode: () =>
              dom.classList.remove("ProseMirror-selectednode"),
            destroy: () => {
              setPreviews((items) => items.filter((item) => item.key !== key));
            },
          };
        },
      },
    });
    view.current = editor;
    register(cell.id, editor);
    return () => {
      cancelAnimationFrame(frame);
      latest.current.onComposition(cell.id, false);
      register(cell.id);
      view.current = undefined;
      if (!editor.isDestroyed) editor.destroy();
    };
  }, [mode, cell.id, register, sourceLabel, initial]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || cell.source === emitted.current) return;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      try {
        const parsed = parseJournal(cell.source, mode);
        emitted.current = cell.source;
        prefix.current = parsed.prefix;
        editor.updateState(
          EditorState.create({
            doc: parsed.doc,
            plugins: editor.state.plugins,
          }),
        );
        setError(undefined);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        editor.destroy();
        view.current = undefined;
        register(cell.id);
        setError(error.message);
      }
    });
    return () => {
      current = false;
    };
  }, [cell.source, cell.id, mode, register]);
  return (
    <section
      className={`notebook-cell journal-editor journal-${mode}`}
      data-journal-cell={cell.id}
    >
      <h4>markdown · {cell.id}</h4>
      <div ref={host} />
      {error && <p role="alert">{error}</p>}
      {previews.map((preview) =>
        createPortal(
          <ScientificView
            source={preview.source}
            projectId={projectId}
            enabled={scientific}
          />,
          preview.host,
          String(preview.key),
        ),
      )}
    </section>
  );
}

/** @id CODE-JOURNAL-EDITOR @implements REQ-MARKDOWN-004 REQ-MARKDOWN-005 */
export function JournalMarkdownEditor({
  cells,
  disabled,
  projectId,
  scientific,
  onChange,
  onInsert,
}: {
  cells: Cell[];
  disabled: boolean;
  projectId: string;
  scientific: boolean;
  onChange: (id: string, source: string) => void;
  onInsert: (source: string) => void;
}) {
  const { t, locale } = useText();
  const [mode, setMode] = useState<JournalMode>("rendered");
  const [composing, setComposing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const views = useRef(new Map<string, EditorView>());
  const active = useRef<string | undefined>(undefined);
  const register = useCallback((id: string, view?: EditorView) => {
    if (view) views.current.set(id, view);
    else views.current.delete(id);
  }, []);
  const onComposition = useCallback((id: string, value: boolean) => {
    setComposing((before) => {
      if (before.has(id) === value) return before;
      const next = new Set(before);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  function command(name: string, level?: number) {
    if (disabled || composing.size) return;
    const stamp = new Date().toISOString();
    if (name === "timestamp" && !cells.length) {
      onInsert(stamp);
      return;
    }
    const id =
      active.current && cells.some((cell) => cell.id === active.current)
        ? active.current
        : cells[0]?.id;
    const editor = id ? views.current.get(id) : undefined;
    if (!editor) {
      setError("JOURNAL_EDITOR_UNAVAILABLE");
      return;
    }
    setError(undefined);
    if (name === "timestamp") {
      const tr = editor.state.tr;
      if (!tr.selection.$from.parent.isTextblock) {
        const end = tr.doc.content.size;
        tr.insert(
          end,
          journalSchema.nodes.paragraph.create(null, journalSchema.text(stamp)),
        );
        tr.setSelection(TextSelection.create(tr.doc, end + 1 + stamp.length));
      } else tr.insertText(stamp);
      editor.dispatch(tr.scrollIntoView());
    } else if (mode === "rendered") {
      if (name === "heading") {
        const current = editor.state.selection.$from.parent;
        const toggle =
          current.type === journalSchema.nodes.heading &&
          current.attrs.level === level;
        setBlockType(
          toggle ? journalSchema.nodes.paragraph : journalSchema.nodes.heading,
          toggle ? undefined : { level },
        )(editor.state, editor.dispatch, editor);
      } else
        toggleMark(journalSchema.marks[name])(
          editor.state,
          editor.dispatch,
          editor,
        );
    }
    editor.focus();
  }
  return (
    <div>
      <div className="toolbar" role="group" aria-label={t("実験ノートの表示")}>
        {(
          [
            ["text", "Text表記"],
            ["rendered", "Markdownレンダリング表記"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={composing.size > 0}
            variant={mode === value ? "default" : "outline"}
            onClick={() => {
              setError(undefined);
              setMode(value);
            }}
          >
            {t(label)}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={disabled || composing.size > 0}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => command("timestamp")}
        >
          {t("タイムスタンプを挿入")}
        </Button>
        {mode === "rendered" && (
          <>
            {([1, 2, 3] as const).map((level) => (
              <Button
                key={level}
                type="button"
                variant="outline"
                disabled={disabled || composing.size > 0}
                aria-label={t(
                  level === 1 ? "見出し1" : level === 2 ? "見出し2" : "見出し3",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => command("heading", level)}
              >
                {"#".repeat(level)}
              </Button>
            ))}
            {(
              [
                ["strong", "太字"],
                ["em", "斜体"],
                ["strike", "打消し線"],
              ] as const
            ).map(([name, label]) => (
              <Button
                key={name}
                type="button"
                variant="outline"
                disabled={disabled || composing.size > 0}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => command(name)}
              >
                {t(label)}
              </Button>
            ))}
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {cells.map((cell) => (
        <JournalCell
          key={`${cell.id}:${mode}:${locale}`}
          cell={cell}
          mode={mode}
          disabled={disabled}
          projectId={projectId}
          scientific={scientific}
          onChange={onChange}
          register={register}
          onFocus={(id) => {
            active.current = id;
          }}
          onComposition={onComposition}
        />
      ))}
    </div>
  );
}

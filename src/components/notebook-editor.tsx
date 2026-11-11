"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Code2,
  Download,
  FilePlus2,
  NotebookPen,
  Plus,
  RotateCcw,
  Save,
  SquarePlay,
} from "lucide-react";
import { z } from "zod";
import type {
  Notebook,
  NotebookDocument,
  Notebooks,
  CodeCell,
  JsonValue,
} from "../server/notebooks";
import type { FileVersion } from "../server/files";
import type { ExcerptSelection } from "../server/chat-context";
import type { Confirmation } from "../server/confirmations";
import type { RuntimeOutcome, RuntimeStatus } from "../server/runtime";
import { plainRunText } from "../server/run-snapshots";
import { api, json, failure, errorText, ClientError } from "./client-api";
import { useAppearance, useText } from "./appearance";
import { updateMarkdownMetadata } from "../lib/markdown-metadata";
import type { Message } from "./messages";
import { ConfirmationPanel } from "./confirmation-panel";
import { ScientificView } from "./scientific-view";
import { NotebookHistory } from "./notebook-history";
import { JournalMarkdownEditor } from "./journal-markdown-editor";
import { SourceReference } from "./source-reference";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
function aira(cell: CodeCell): Record<string, JsonValue> {
  const value = cell.metadata.aira;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
/** @id CODE-UI-NOTEBOOK @implements REQ-UI-001 REQ-UI-002 REQ-UI-003 REQ-MARKDOWN-001 REQ-MARKDOWN-002 */
export function NotebookEditor({
  projectId,
  readOnly,
  scientific,
  onShare,
  mode = "all",
  notebookId,
  refreshKey = 0,
  onOpen,
  onDirtyChange,
  onChanged,
  disabled = false,
  onBusyChange,
}: {
  projectId: string;
  readOnly: boolean;
  scientific: boolean;
  onShare: (selection: ExcerptSelection) => void;
  mode?: "all" | "manager" | "viewer" | "journal";
  notebookId?: string;
  refreshKey?: number;
  onOpen?: (notebook: Pick<Notebook, "id" | "name">) => void;
  onDirtyChange?: (id: string, value: boolean) => void;
  onChanged?: () => Promise<void>;
  disabled?: boolean;
  onBusyChange?: (value: boolean) => void;
}) {
  const { t, locale } = useText();
  const { preferences } = useAppearance();
  const [journalId, setJournalId] = useState<string>();
  const selectedId = mode === "journal" ? journalId : notebookId;
  const manager = mode === "all" || mode === "manager";
  const markdownOriginal = useRef(new Map<string, string>());
  const [markdownModes, setMarkdownModes] = useState<
    Record<string, "source" | "rendered" | "edit">
  >({});
  const root = `/api/projects/${projectId}`;
  const [list, setList] = useState<Awaited<ReturnType<Notebooks["list"]>>>([]),
    [versions, setVersions] = useState<FileVersion[]>([]);
  const [notebook, setNotebook] = useState<Notebook>(),
    [imported, setImported] =
      useState<Awaited<ReturnType<Notebooks["imported"]>>>();
  const [history, setHistory] = useState<
    Awaited<ReturnType<Notebooks["history"]>>
  >([]);
  const [kernel, setKernel] = useState<RuntimeStatus>(),
    [inputs, setInputs] = useState<string[]>([]);
  const [sharing, setSharing] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const dirtyNow = useRef(false);
  const loadSequence = useRef(0);
  const editGeneration = useRef(0);
  const changeDirty = useCallback(
    (value: boolean) => {
      dirtyNow.current = value;
      if (value) editGeneration.current++;
      setDirty(value);
      if (selectedId) onDirtyChange?.(selectedId, value);
    },
    [selectedId, onDirtyChange],
  );
  const [pending, setPending] = useState<Confirmation>(),
    [restart, setRestart] = useState<RuntimeStatus>();
  const [acting, setBusy] = useState(false),
    [error, setError] = useState<Error>(),
    [status, setStatus] = useState<Message>(),
    [name, setName] = useState("");
  const busy = acting || disabled;
  useEffect(() => {
    if (mode !== "journal") return;
    let current = true;
    void api<Notebook>(`${root}/lab-note`)
      .then((value) => {
        if (current) setJournalId(value.id);
      })
      .catch((error) => {
        if (current) setError(failure(error));
      });
    return () => {
      current = false;
    };
  }, [root, mode]);
  const read = useCallback(async () => {
    const [notebooks, files] = await Promise.all([
      api<{ notebooks: Awaited<ReturnType<Notebooks["list"]>> }>(
        `/api/projects/${projectId}/notebooks`,
      ),
      api<{ versions: FileVersion[] }>(`/api/projects/${projectId}/files`),
    ]);
    return { notebooks: notebooks.notebooks, versions: files.versions };
  }, [projectId]);
  useEffect(() => {
    void read()
      .then((value) => {
        setList(value.notebooks);
        setVersions(value.versions);
      })
      .catch((error) => setError(failure(error)));
  }, [read, refreshKey]);
  const load = useCallback(
    async (id: string, allowDirty = false) => {
      const sequence = ++loadSequence.current;
      const generation = editGeneration.current;
      const [value, imported, runs, kernel] = await Promise.all([
        api<Notebook>(`${root}/notebooks/${id}`),
        api<Awaited<ReturnType<Notebooks["imported"]>>>(
          `${root}/notebooks/${id}/imported`,
        ),
        api<{ runs: Awaited<ReturnType<Notebooks["history"]>> }>(
          `${root}/notebooks/${id}/history`,
        ),
        mode === "journal"
          ? Promise.resolve(undefined)
          : api<RuntimeStatus>(`${root}/runtime/${id}`),
      ]);
      if (
        sequence !== loadSequence.current ||
        generation !== editGeneration.current ||
        (!allowDirty && dirtyNow.current)
      )
        return;
      setNotebook(value);
      markdownOriginal.current = new Map(
        value.document.cells
          .filter((cell) => cell.cell_type === "markdown")
          .map((cell) => [cell.id, cell.source]),
      );
      setImported(imported);
      setHistory(runs.runs);
      setKernel(kernel);
      changeDirty(false);
      setSharing(
        Object.fromEntries(
          value.document.cells
            .filter((cell) => cell.cell_type === "code")
            .map((cell) => [cell.id, JSON.stringify(aira(cell).sharing ?? [])]),
        ),
      );
    },
    [root, changeDirty, mode],
  );
  useEffect(() => {
    if (selectedId && !dirtyNow.current)
      void load(selectedId).catch((error) => setError(failure(error)));
  }, [selectedId, refreshKey, load]);
  useEffect(
    () => () => {
      loadSequence.current++;
    },
    [],
  );
  async function act(run: () => Promise<void>) {
    setBusy(true);
    onBusyChange?.(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await run();
      await onChanged?.();
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  function edit(document: NotebookDocument) {
    if (notebook) setNotebook({ ...notebook, document });
    changeDirty(true);
    setPending(undefined);
  }
  async function save() {
    if (!notebook) throw new ClientError("NOTEBOOK_REQUIRED");
    const now = new Date().toISOString();
    const document: NotebookDocument = {
      ...notebook.document,
      cells: notebook.document.cells.map((cell) => {
        if (cell.cell_type === "markdown") {
          const source = updateMarkdownMetadata(
            cell.source,
            preferences.editorName,
            now,
            markdownOriginal.current.get(cell.id),
          );
          if (new TextEncoder().encode(source).length > 65536)
            throw new ClientError("MARKDOWN_CELL_BUDGET_EXCEEDED");
          return { ...cell, source };
        }
        if (cell.cell_type !== "code") return cell;
        const value: unknown = JSON.parse(
          sharing[cell.id] ?? JSON.stringify(aira(cell).sharing ?? []),
        );
        const variables = z.array(z.json()).parse(value);
        return {
          ...cell,
          metadata: {
            ...cell.metadata,
            aira: { ...aira(cell), sharing: variables },
          },
        };
      }),
    };
    const saved = await api<Notebook>(`${root}/notebooks/${notebook.id}`, {
      ...json({
        revision: notebook.revision,
        document,
        editorName: preferences.editorName,
      }),
      method: "PUT",
    });
    await load(saved.id, true);
    setStatus("保存しました");
  }
  return (
    <section className="notebook-manager">
      <h2 className="flex items-center gap-2">
        <NotebookPen size={19} className="text-primary" aria-hidden="true" />
        {mode === "journal"
          ? t("実験ノート")
          : mode === "manager"
            ? t("ipynb")
            : "Notebook"}
      </h2>
      {manager && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const value = await api<Notebook>(
                  `${root}/notebooks`,
                  json({
                    name,
                    editorName: preferences.editorName,
                    document: {
                      nbformat: 4,
                      nbformat_minor: 5,
                      metadata: {},
                      cells: [],
                    },
                  }),
                );
                setName("");
                setList((await read()).notebooks);
                if (onOpen) onOpen(value);
                else await load(value.id);
              });
            }}
          >
            <label>
              {t("Notebook 名")}
              <Input
                disabled={readOnly || busy}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
              />
            </label>
            <Button disabled={readOnly || busy}>
              <FilePlus2 aria-hidden="true" />
              {t("Notebook を作成")}
            </Button>
          </form>
          <label>
            {t("ipynb をインポート")}
            <input
              type="file"
              accept=".ipynb,application/x-ipynb+json"
              disabled={readOnly || busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void act(async () => {
                  const value = await api<Notebook>(
                    `${root}/notebooks/import?name=${encodeURIComponent(file.name)}`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/x-ipynb+json" },
                      body: file,
                    },
                  );
                  setList((await read()).notebooks);
                  if (onOpen) onOpen(value);
                  else await load(value.id);
                });
                event.target.value = "";
              }}
            />
          </label>
        </>
      )}
      {manager && (
        <ul className="lab-notebook-list">
          {list.map((item) => (
            <li key={item.id}>
              <button
                disabled={busy}
                onClick={() =>
                  onOpen
                    ? onOpen(item)
                    : void act(async () => {
                        setPending(undefined);
                        setRestart(undefined);
                        await load(item.id);
                      })
                }
              >
                {item.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{errorText(error, locale)}</p>}
      {mode === "journal" && !notebook && !error && (
        <p role="status">{t("実験ノートを読み込み中")}</p>
      )}
      {status && <p role="status">{t(status)}</p>}
      {status === "保存しました" && (
        <p>
          {t("DB に保存しました。Git の出力状態は保存履歴で確認できます。")}
        </p>
      )}
      {notebook && (
        <article className="notebook-document">
          <h3>{notebook.name}</h3>
          <p>
            {t("保存リビジョン")} {notebook.revision}
          </p>
          {dirty && (
            <p role="status">
              {t(
                "未保存の変更があります。実行内容を確認する前に Notebook を保存してください。",
              )}
            </p>
          )}
          {imported && (
            <aside>
              <p role="status">{t("インポート履歴・未実行")}</p>
              <p>
                {t(
                  "外部の出力は実行済みのネイティブ記録ではありません。HTML/MIME は実行しません。",
                )}
              </p>
              <details>
                <summary>{t("元のインポート履歴")}</summary>
                <pre>{JSON.stringify(imported, null, 2)}</pre>
              </details>
            </aside>
          )}
          {mode !== "journal" && (
            <a
              className="inline-flex items-center gap-2 text-sm"
              href={`${root}/notebooks/${notebook.id}/export`}
              download
            >
              <Download size={15} aria-hidden="true" />
              {t("ipynb をエクスポート")}
            </a>
          )}
          <div className="toolbar">
            <NotebookHistory
              key={notebook.id}
              projectId={projectId}
              notebookId={notebook.id}
              currentRevision={notebook.revision}
              readOnly={readOnly}
              dirty={dirty}
              disabled={busy}
              onBusyChange={(value) => {
                setBusy(value);
                onBusyChange?.(value);
              }}
              onRestore={async (saved) => {
                await load(saved.id, true);
                await onChanged?.();
                setStatus("保存しました");
              }}
            />
            <Button disabled={readOnly || busy} onClick={() => void act(save)}>
              <Save aria-hidden="true" />
              {t("Notebook を保存")}
            </Button>
            {mode !== "journal" && (
              <Button
                variant="outline"
                disabled={readOnly || busy}
                onClick={() =>
                  edit({
                    ...notebook.document,
                    cells: [
                      ...notebook.document.cells,
                      {
                        id: crypto.randomUUID(),
                        cell_type: "code",
                        source: "",
                        metadata: { aira: { language: "python", sharing: [] } },
                        outputs: [],
                        execution_count: null,
                      },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                {t("コードセルを追加")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={readOnly || busy}
              onClick={() => {
                const id = crypto.randomUUID();
                setMarkdownModes((modes) => ({ ...modes, [id]: "edit" }));
                edit({
                  ...notebook.document,
                  cells: [
                    ...notebook.document.cells,
                    {
                      id,
                      cell_type: "markdown",
                      source: "",
                      metadata: {},
                    },
                  ],
                });
              }}
            >
              <Plus aria-hidden="true" />
              {t("Markdown セルを追加")}
            </Button>
            {mode !== "journal" && (
              <Button
                variant="ghost"
                disabled={readOnly || busy || !kernel?.kernelEpoch}
                onClick={() => setRestart(kernel)}
              >
                <RotateCcw aria-hidden="true" />
                {t("カーネルを再起動")}
              </Button>
            )}
          </div>
          {mode !== "journal" && (
            <fieldset disabled={readOnly || busy}>
              <legend>{t("実行に渡す不変入力バージョン")}</legend>
              {versions.map((file) => (
                <label key={file.id}>
                  <input
                    type="checkbox"
                    checked={inputs.includes(file.id)}
                    onChange={(event) => {
                      setInputs(
                        event.target.checked
                          ? [...inputs, file.id]
                          : inputs.filter((id) => id !== file.id),
                      );
                      setPending(undefined);
                    }}
                  />
                  {t("入力")} {file.name}
                  <small>
                    {file.id} · SHA256 {file.sha256}
                  </small>
                </label>
              ))}
            </fieldset>
          )}
          {mode === "journal" && (
            <JournalMarkdownEditor
              cells={notebook.document.cells.filter(
                (cell) => cell.cell_type === "markdown",
              )}
              disabled={readOnly || busy}
              projectId={projectId}
              scientific={scientific}
              onChange={(id, source) => {
                if (readOnly || busy) return;
                edit({
                  ...notebook.document,
                  cells: notebook.document.cells.map((cell) =>
                    cell.id === id ? { ...cell, source } : cell,
                  ),
                });
              }}
              onInsert={(source) => {
                if (readOnly || busy) return;
                edit({
                  ...notebook.document,
                  cells: [
                    ...notebook.document.cells,
                    {
                      id: crypto.randomUUID(),
                      cell_type: "markdown",
                      source,
                      metadata: {},
                    },
                  ],
                });
              }}
            />
          )}
          {mode !== "journal" &&
            notebook.document.cells.map((cell) => (
              <section className="notebook-cell" key={cell.id}>
                <h4>
                  <Code2 size={15} aria-hidden="true" />
                  {cell.cell_type} · {cell.id}
                </h4>
                {cell.cell_type === "markdown" && (
                  <div
                    role="group"
                    aria-label={`${t("Markdownセルの表示")} ${cell.id}`}
                    className="my-3 flex flex-wrap gap-2"
                  >
                    {(
                      [
                        ["source", "原文を表示"],
                        ["rendered", "レンダリングを表示"],
                        ["edit", "編集"],
                      ] as const
                    ).map(([value, label]) => (
                      <Button
                        key={value}
                        type="button"
                        size="sm"
                        aria-pressed={
                          (markdownModes[cell.id] ?? "rendered") === value
                        }
                        variant={
                          (markdownModes[cell.id] ?? "rendered") === value
                            ? "default"
                            : "outline"
                        }
                        disabled={busy || (value === "edit" && readOnly)}
                        onClick={() =>
                          setMarkdownModes((modes) => ({
                            ...modes,
                            [cell.id]: value,
                          }))
                        }
                      >
                        {t(label)}
                      </Button>
                    ))}
                  </div>
                )}
                {(cell.cell_type !== "markdown" ||
                  markdownModes[cell.id] === "edit") && (
                  <label>
                    {t("ソース")} {cell.id}
                    <Textarea
                      className="code-source"
                      aria-label={`${t("ソース")} ${cell.id}`}
                      disabled={readOnly || busy}
                      value={cell.source}
                      onChange={(event) =>
                        edit({
                          ...notebook.document,
                          cells: notebook.document.cells.map((item) =>
                            item.id === cell.id
                              ? { ...item, source: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                )}
                {cell.cell_type === "markdown" &&
                  markdownModes[cell.id] !== "edit" && (
                    <ScientificView
                      source={cell.source}
                      enabled={
                        scientific && markdownModes[cell.id] !== "source"
                      }
                      projectId={projectId}
                    />
                  )}
                {cell.cell_type === "code" && (
                  <>
                    <label>
                      {t("言語")} {cell.id}
                      <select
                        aria-label={`${t("言語")} ${cell.id}`}
                        disabled={readOnly || busy}
                        value={aira(cell).language === "r" ? "r" : "python"}
                        onChange={(event) =>
                          edit({
                            ...notebook.document,
                            cells: notebook.document.cells.map((item) =>
                              item.id === cell.id
                                ? {
                                    ...cell,
                                    metadata: {
                                      ...cell.metadata,
                                      aira: {
                                        ...aira(cell),
                                        language: event.target.value,
                                      },
                                    },
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="python">Python</option>
                        <option value="r">R</option>
                      </select>
                    </label>
                    <label>
                      {t("変数共有")} {cell.id}
                      <Textarea
                        className="code-source"
                        aria-label={`${t("変数共有")} ${cell.id}`}
                        disabled={readOnly || busy}
                        value={sharing[cell.id] ?? "[]"}
                        onChange={(event) => {
                          setSharing({
                            ...sharing,
                            [cell.id]: event.target.value,
                          });
                          changeDirty(true);
                          setPending(undefined);
                        }}
                      />
                    </label>
                    <p>
                      {t("共有例")}:{" "}
                      {`[{"name":"x","direction":"python-to-r","family":"scalar"}]`}{" "}
                      {t("暗黙の変数共有は行いません。")}
                    </p>
                    <Button
                      size="sm"
                      disabled={readOnly || busy || dirty}
                      onClick={() =>
                        void act(async () => {
                          const current = await api<Notebook>(
                            `${root}/notebooks/${notebook.id}`,
                          );
                          const confirmation = await api<Confirmation>(
                            `${root}/confirmations/execution`,
                            json({
                              notebookId: notebook.id,
                              cellId: cell.id,
                              revision: current.revision,
                              inputs: versions
                                .filter((file) => inputs.includes(file.id))
                                .map((file) => ({
                                  id: file.id,
                                  name: file.name,
                                  sha256: file.sha256,
                                })),
                            }),
                          );
                          setPending(confirmation);
                        })
                      }
                    >
                      <SquarePlay aria-hidden="true" />
                      {t("実行内容を確認")} {cell.id}
                    </Button>
                  </>
                )}
                {notebook.results[cell.id] && (
                  <aside>
                    {notebook.results[cell.id].stale && (
                      <p role="status">{t("古い実行結果")}</p>
                    )}
                    {notebook.results[cell.id].lostState && (
                      <p role="status">{t("カーネル状態喪失")}</p>
                    )}
                    <p>
                      {t("実行状態")}: {notebook.results[cell.id].status}
                    </p>
                    <pre>
                      {JSON.stringify(
                        notebook.results[cell.id].currentOutputs,
                        null,
                        2,
                      )}
                    </pre>
                    <SourceReference
                      projectId={projectId}
                      kind="run"
                      sourceId={notebook.results[cell.id].runId}
                    />
                    <button
                      disabled={readOnly || busy}
                      onClick={() => {
                        const text = plainRunText(
                          notebook.results[cell.id].historicalOutputs ??
                            notebook.results[cell.id].currentOutputs,
                        );
                        if (!text.length) {
                          setError(failure(new ClientError("NO_PLAIN_RESULT")));
                          return;
                        }
                        onShare({
                          kind: "result",
                          sourceId: notebook.results[cell.id].runId,
                          start: 0,
                          end: [...text].length,
                        });
                      }}
                    >
                      {t("結果をチャットへ")}
                    </button>
                  </aside>
                )}
              </section>
            ))}
          <details>
            <summary>{t("保存済み実行履歴")}</summary>
            <p>
              {t(
                "保存時点の不変記録です。現在のカーネル状態や科学的妥当性の証明ではありません。",
              )}
            </p>
            {history.map((run) => (
              <article key={run.id}>
                <SourceReference
                  projectId={projectId}
                  kind="run"
                  sourceId={run.id}
                />
                <pre>{JSON.stringify(run, null, 2)}</pre>
              </article>
            ))}
          </details>
          {pending && (
            <ConfirmationPanel
              title={t("コード実行の確認")}
              payload={pending}
              onReject={async () => {
                await api(`${root}/confirmations/${pending.id}`, {
                  method: "DELETE",
                });
                await load(notebook.id);
                setPending(undefined);
              }}
              onApprove={async () => {
                const value = await api<RuntimeOutcome>(
                  `${root}/notebooks/${notebook.id}/execute`,
                  json({
                    confirmationId: pending.id,
                    fingerprint: pending.fingerprint,
                    requestId: crypto.randomUUID(),
                  }),
                );
                if (value.job.state !== "completed")
                  throw new ClientError(
                    "EXECUTION_INCOMPLETE",
                    undefined,
                    `${value.code} (${value.job.state})`,
                  );
                setPending(undefined);
                await load(notebook.id);
                setStatus("実行完了");
                await onChanged?.();
              }}
            />
          )}
          {restart && (
            <ConfirmationPanel
              title={t("カーネル状態を破棄する再起動")}
              payload={{
                notebookId: notebook.id,
                kernelEpoch: restart.kernelEpoch,
              }}
              onReject={async () => {
                setRestart(undefined);
              }}
              onApprove={async () => {
                await api(
                  `${root}/runtime/${notebook.id}/restart`,
                  json({ kernelEpoch: restart.kernelEpoch }),
                );
                setRestart(undefined);
                await load(notebook.id);
              }}
            />
          )}
        </article>
      )}
    </section>
  );
}

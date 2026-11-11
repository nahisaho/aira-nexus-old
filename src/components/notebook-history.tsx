"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import type { Notebook } from "../server/notebooks";
import type {
  GitStatus,
  VersionSummary,
  VersionDetail,
  VersionDiff,
} from "../server/notebook-versions";
import { useAppearance, useText } from "./appearance";
import { api, errorText, failure, json } from "./client-api";
import type { Message } from "./messages";
import { Modal } from "./modal";
import { Button } from "./ui/button";

export interface NotebookHistoryProps {
  projectId: string;
  notebookId: string;
  currentRevision: number;
  readOnly: boolean;
  dirty: boolean;
  disabled: boolean;
  onRestore: (notebook: Notebook) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}

interface VersionPage {
  versions: VersionSummary[];
  nextCursor: string | null;
  git: GitStatus;
}

type Confirmation =
  | { kind: "restore"; version: VersionSummary; currentRevision: number }
  | { kind: "rebuild"; generation: string | null };

function SourceBlock({ source }: { source: string }) {
  const { t } = useText();
  const bytes = new TextEncoder().encode(source);
  let end = Math.min(bytes.length, 65536);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const value = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.slice(0, end),
  );
  return (
    <>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
        {value}
      </pre>
      {end < bytes.length && (
        <p role="status">
          {t("省略したバイト数")}: {bytes.length - end}
        </p>
      )}
    </>
  );
}

function CellMetadata({
  cell,
}: {
  cell: Notebook["document"]["cells"][number];
}) {
  const { t } = useText();
  return (
    <details>
      <summary>{t("セルのメタ情報")}</summary>
      <SourceBlock
        source={JSON.stringify(
          {
            metadata: cell.metadata,
            attachments: "attachments" in cell ? cell.attachments : undefined,
          },
          null,
          2,
        )}
      />
    </details>
  );
}

const origins: Record<string, Message> = {
  baseline: "既存の現在版",
  create: "ノート作成",
  import: "インポート",
  save: "保存",
  patch: "部分更新",
  proposal: "AI 提案の適用",
  restore: "過去版の復元",
};

const gitLabels: Record<GitStatus["status"], Message> = {
  pending: "Git 出力待ち",
  exported: "Git 出力済み",
  error: "Git 出力に失敗しました",
  blocked: "Git 出力が停止しています",
};

const changes: Record<string, Message> = {
  added: "セル追加",
  removed: "セル削除",
  source: "ソース変更",
  type: "セル種別変更",
  metadata: "メタ情報変更",
  attachments: "添付データ変更",
  order: "セル順序変更",
};

/** @id CODE-NH-UI @implements REQ-NH-003 REQ-NH-004 REQ-NH-007 */
export function NotebookHistory({
  projectId,
  notebookId,
  currentRevision,
  readOnly,
  dirty,
  disabled,
  onRestore,
  onBusyChange,
}: NotebookHistoryProps) {
  const { t, locale } = useText();
  const { preferences } = useAppearance();
  const root = `/api/projects/${projectId}/notebooks/${notebookId}/versions`;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<VersionPage>();
  const [selection, setSelection] = useState<VersionSummary>();
  const [detail, setDetail] = useState<VersionDetail>();
  const [diff, setDiff] = useState<VersionDiff>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const busy = acting || disabled;

  const read = useCallback(
    async (cursor?: string, preserve = false) => {
      const sequence = ++listSequence.current;
      if (!preserve) setLoading(true);
      try {
        const value = await api<VersionPage>(
          `${root}?limit=50${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (sequence !== listSequence.current) return;
        setPage((previous) => {
          if (
            !previous ||
            (!cursor && !preserve) ||
            (preserve && value.versions[0]?.id !== previous.versions[0]?.id)
          )
            return value;
          const merged = new Map(
            (cursor
              ? [...previous.versions, ...value.versions]
              : [...value.versions, ...previous.versions]
            ).map((version) => [version.id, version]),
          );
          if (preserve) {
            for (const version of value.versions)
              merged.set(version.id, version);
          }
          return {
            ...value,
            versions: [...merged.values()],
            nextCursor: cursor ? value.nextCursor : previous.nextCursor,
          };
        });
      } catch (error) {
        if (sequence === listSequence.current) setError(failure(error));
      } finally {
        if (sequence === listSequence.current && !preserve) setLoading(false);
      }
    },
    [root],
  );

  useEffect(
    () => () => {
      listSequence.current++;
      detailSequence.current++;
    },
    [],
  );

  useEffect(() => {
    if (
      !open ||
      !page ||
      loading ||
      acting ||
      error ||
      page.git.status === "exported" ||
      page.git.status === "blocked"
    )
      return;
    const timer = setTimeout(() => void read(undefined, true), 1500);
    return () => clearTimeout(timer);
  }, [open, page, loading, acting, error, read]);

  async function select(version: VersionSummary) {
    const sequence = ++detailSequence.current;
    setSelection(version);
    setDetail(undefined);
    setDiff(undefined);
    setError(undefined);
    setLoading(true);
    try {
      const value = await api<VersionDetail>(`${root}/${version.revision}`);
      if (sequence === detailSequence.current) setDetail(value);
    } catch (error) {
      if (sequence === detailSequence.current) setError(failure(error));
    } finally {
      if (sequence === detailSequence.current) setLoading(false);
    }
  }

  async function execute(run: () => Promise<void>) {
    setActing(true);
    onBusyChange(true);
    setError(undefined);
    try {
      await run();
    } catch (error) {
      setError(failure(error));
      setConfirmation(undefined);
    } finally {
      setActing(false);
      onBusyChange(false);
    }
  }

  function close() {
    if (busy) return;
    listSequence.current++;
    detailSequence.current++;
    setOpen(false);
    setSelection(undefined);
    setDetail(undefined);
    setDiff(undefined);
    setConfirmation(undefined);
  }

  return (
    <>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setPage(undefined);
          setError(undefined);
          setOpen(true);
          void read();
        }}
      >
        <History aria-hidden="true" />
        {t("保存履歴")}
      </Button>
      {open && (
        <Modal title={t("保存履歴")} busy={busy} onClose={close}>
          <div className="max-h-[70vh] max-w-4xl space-y-4 overflow-auto">
            <p>
              {t("編集者名は自己申告です。本人確認済みの履歴ではありません。")}
            </p>
            <p>
              {t("保存版の表示だけでは、保存・実行・外部送信は行いません。")}
            </p>
            {error && <p role="alert">{errorText(error, locale)}</p>}
            {loading && <p role="status">{t("読み込み中")}</p>}
            {page && (
              <>
                <p
                  role={
                    page.git.status === "error" || page.git.status === "blocked"
                      ? "alert"
                      : "status"
                  }
                >
                  {t(gitLabels[page.git.status])}
                  {page.git.errorCode && ` (${page.git.errorCode})`}
                </p>
                {page.git.rebuilt && (
                  <p>
                    {t(
                      "Git は新しい世代へ再構築されています。DB の版IDが正本です。",
                    )}
                  </p>
                )}
                {page.versions.some(
                  (version) => version.origin === "baseline",
                ) && (
                  <p>
                    {t(
                      "既存の現在版の記録時刻は移行時刻です。過去の編集日時・編集者を再現したものではありません。",
                    )}
                  </p>
                )}
                <p>
                  {t(
                    "Git の再試行・再構築は、このプロジェクト内の全ノートが対象です。",
                  )}
                </p>
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || loading}
                onClick={() => {
                  setError(undefined);
                  void read();
                }}
              >
                <RefreshCw aria-hidden="true" />
                {t("履歴を再読み込み")}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !page}
                onClick={() =>
                  void execute(async () => {
                    await api(`${root}/git/retry`, json({}));
                    await read();
                  })
                }
              >
                {t("Git 出力を再試行")}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !page}
                onClick={() => {
                  if (page)
                    setConfirmation({
                      kind: "rebuild",
                      generation: page.git.generation,
                    });
                }}
              >
                {t("Git を新しい世代へ再構築")}
              </Button>
            </div>
            <ul className="space-y-2" aria-label={t("保存版の一覧")}>
              {page?.versions.map((version) => (
                <li key={version.id} className="rounded border p-2 text-sm">
                  <Button
                    variant={
                      selection?.id === version.id ? "secondary" : "ghost"
                    }
                    aria-pressed={selection?.id === version.id}
                    disabled={busy || loading}
                    onClick={() => void select(version)}
                  >
                    {t("リビジョン")} {version.revision}
                  </Button>
                  <span className="ml-2">
                    {origins[version.origin]
                      ? t(origins[version.origin])
                      : version.origin}
                    {" · "}
                    {version.editor ?? t("不明")}
                    {" · "}
                    {t("サーバ記録時刻")}:{" "}
                    <time dateTime={version.createdAt}>
                      {new Date(version.createdAt).toLocaleString(
                        locale === "ja" ? "ja-JP" : "en-US",
                      )}
                    </time>
                    {" · "}
                    {t(gitLabels[version.git.state])}
                    {version.git.commit &&
                      ` ${version.git.commit.slice(0, 12)}`}
                  </span>
                  {version.reason && <p>{version.reason}</p>}
                  {version.restoredFrom !== null && (
                    <p>
                      {t("復元元リビジョン")}: {version.restoredFrom}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {page?.nextCursor && (
              <Button
                variant="outline"
                disabled={busy || loading}
                onClick={() => void read(page.nextCursor ?? undefined)}
              >
                {t("さらに読み込む")}
              </Button>
            )}
            {selection && (
              <section aria-label={t("保存版の内容")} className="space-y-3">
                <h3>
                  {selection.name} · {t("リビジョン")} {selection.revision}
                </h3>
                <p className="break-all text-xs">SHA-256: {selection.sha256}</p>
                {detail?.document.cells.map((cell) => (
                  <div key={cell.id}>
                    <h4>
                      {cell.id} · {cell.cell_type}
                    </h4>
                    <SourceBlock source={cell.source} />
                    <CellMetadata cell={cell} />
                  </div>
                ))}
                {detail && (
                  <details>
                    <summary>{t("ノートのメタ情報")}</summary>
                    <SourceBlock
                      source={JSON.stringify(detail.document.metadata, null, 2)}
                    />
                  </details>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || loading || !detail}
                    onClick={() =>
                      void execute(async () => {
                        setDiff(
                          await api<VersionDiff>(
                            `${root}/${selection.revision}/diff?against=${currentRevision}`,
                          ),
                        );
                      })
                    }
                  >
                    {t("現在版との差分")}
                  </Button>
                  <Button
                    disabled={busy || loading || !detail || dirty || readOnly}
                    onClick={() => {
                      setConfirmation({
                        kind: "restore",
                        version: selection,
                        currentRevision,
                      });
                    }}
                  >
                    {t("この版を復元")}
                  </Button>
                </div>
                {dirty && (
                  <p role="status">
                    {t(
                      "未保存の変更があるため復元できません。先に保存してください。",
                    )}
                  </p>
                )}
                {readOnly && <p>{t("アーカイブ済み・読み取り専用")}</p>}
                {diff && (
                  <section aria-label={t("保存版の差分")} className="space-y-3">
                    <h4>
                      {t("保存版の差分")}: {diff.fromRevision} →{" "}
                      {diff.toRevision}
                    </h4>
                    {diff.nameChanged && (
                      <p>
                        {diff.beforeName} → {diff.afterName}
                      </p>
                    )}
                    {diff.cells.map((cell) => (
                      <article key={cell.id} className="rounded border p-3">
                        <h5>{cell.id}</h5>
                        <p>
                          {cell.changes
                            .map((change) =>
                              changes[change] ? t(changes[change]) : change,
                            )
                            .join(", ")}
                        </p>
                        <p>
                          {t("セル位置")}:{" "}
                          {cell.beforeIndex === null
                            ? "—"
                            : cell.beforeIndex + 1}{" "}
                          →{" "}
                          {cell.afterIndex === null ? "—" : cell.afterIndex + 1}
                        </p>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div>
                            <h6>{t("復元元の保存版")}</h6>
                            {cell.before && (
                              <>
                                <p>{cell.before.cell_type}</p>
                                <SourceBlock source={cell.before.source} />
                                <CellMetadata cell={cell.before} />
                              </>
                            )}
                          </div>
                          <div>
                            <h6>{t("現在の保存版")}</h6>
                            {cell.after && (
                              <>
                                <p>{cell.after.cell_type}</p>
                                <SourceBlock source={cell.after.source} />
                                <CellMetadata cell={cell.after} />
                              </>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                    {diff.cells.length === 0 && !diff.nameChanged && (
                      <p>{t("比較対象のセルとノート名に差分はありません")}</p>
                    )}
                  </section>
                )}
              </section>
            )}
          </div>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={t(
            confirmation.kind === "restore"
              ? "保存版の復元を確認"
              : "Git の再構築を確認",
          )}
          busy={busy}
          onClose={() => setConfirmation(undefined)}
        >
          <p>
            {t(
              confirmation.kind === "restore"
                ? "当時の本文と YAML を新しい版として復元します。実行結果やカーネル変数は復元・再実行しません。"
                : "このプロジェクトの全保存版から Git を新しい世代へ再構築します。既存のリポジトリは削除しません。",
            )}
          </p>
          {confirmation.kind === "restore" && (
            <p>
              {t("リビジョン")} {confirmation.version.revision} →{" "}
              {t("現在の保存版")} {confirmation.currentRevision}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              {t("キャンセル")}
            </Button>
            <Button
              disabled={
                busy || (confirmation.kind === "restore" && (dirty || readOnly))
              }
              onClick={() =>
                void execute(async () => {
                  if (confirmation.kind === "restore") {
                    const saved = await api<Notebook>(
                      `${root}/${confirmation.version.revision}/restore`,
                      json({
                        revision: confirmation.currentRevision,
                        editorName: preferences.editorName,
                      }),
                    );
                    setConfirmation(undefined);
                    await onRestore(saved);
                    setOpen(false);
                    setSelection(undefined);
                    setDetail(undefined);
                    setDiff(undefined);
                  } else {
                    await api(
                      `${root}/git/rebuild`,
                      json({
                        generation: confirmation.generation,
                        confirmed: true,
                      }),
                    );
                    setConfirmation(undefined);
                    await read();
                  }
                })
              }
            >
              {t(
                confirmation.kind === "restore"
                  ? "新しい版として復元"
                  : "再構築を開始",
              )}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

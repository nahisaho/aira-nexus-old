"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileText, Files, Upload } from "lucide-react";
import Image from "next/image";
import type { FileVersion } from "../server/files";
import type { ExcerptSelection } from "../server/chat-context";
import type { CheckReport } from "../server/research-checks";
import { api, json, failure, errorText, ClientError } from "./client-api";
import { useAppearance, useText } from "./appearance";
import { isMarkdownFile, markdownUpload } from "../lib/markdown-metadata";
import { ScientificView } from "./scientific-view";
import { SourceReference } from "./source-reference";
import { Button } from "./ui/button";
type Preview =
  | { kind: "text"; text: string; omittedBytes: number }
  | { kind: "image"; source: string };
async function readPreview(
  projectId: string,
  file: FileVersion,
  signal: AbortSignal,
): Promise<Preview> {
  const action = file.mime === "image/svg+xml" ? "image" : "preview";
  const url = `/api/projects/${projectId}/files/${file.id}/${action}`;
  if (!["image/png", "image/jpeg", "image/svg+xml"].includes(file.mime))
    return api<Extract<Preview, { kind: "text" }>>(url, { signal });
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok)
    throw new ClientError("PREVIEW_READ_FAILED", response.status);
  const blob = await response.blob();
  signal.throwIfAborted();
  const source = await new Promise<string>((done, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal.addEventListener("abort", abort, { once: true });
    reader.onloadend = () => signal.removeEventListener("abort", abort);
    reader.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    reader.onerror = () => reject(new ClientError("IMAGE_PREVIEW_READ_FAILED"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? done(reader.result)
        : reject(new ClientError("IMAGE_PREVIEW_READ_FAILED"));
    reader.readAsDataURL(blob);
  });
  signal.throwIfAborted();
  return { kind: "image", source };
}
type FilesPanelProps = {
  projectId: string;
  readOnly: boolean;
  scientific: boolean;
  onShare: (selection: ExcerptSelection) => void;
  mode?: "all" | "explorer" | "viewer";
  file?: FileVersion;
  onOpen?: (file: FileVersion) => void;
  refreshKey?: number;
  onChanged?: () => Promise<void>;
};
/** @id CODE-UI-FILES @implements REQ-UI-001 REQ-UI-002 REQ-UI-003 */
export function FilesPanel(props: FilesPanelProps) {
  return (
    <FilesPanelContent
      key={JSON.stringify([props.projectId, props.mode, props.file?.id])}
      {...props}
    />
  );
}
function FilesPanelContent({
  projectId,
  readOnly,
  scientific,
  onShare,
  mode = "all",
  file,
  onOpen,
  refreshKey = 0,
  onChanged,
}: FilesPanelProps) {
  const { t, locale } = useText();
  const { preferences } = useAppearance();
  const active = useRef<AbortController | null>(null);
  const [versions, setVersions] = useState<FileVersion[]>([]),
    [selected, setSelected] = useState<FileVersion | undefined>(file);
  const [loaded, setLoaded] = useState(false);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [preview, setPreview] = useState<{
    text: string;
    omittedBytes: number;
  }>();
  const [image, setImage] = useState(""),
    [error, setError] = useState<Error>(),
    [report, setReport] = useState<CheckReport>();
  const [start, setStart] = useState("0"),
    [end, setEnd] = useState("0"),
    [busy, setBusy] = useState(Boolean(file));
  const markdown = Boolean(selected && isMarkdownFile(selected.name));
  const read = useCallback(
    () => api<{ versions: FileVersion[] }>(`/api/projects/${projectId}/files`),
    [projectId],
  );
  const load = async () => {
    const value = await read();
    setVersions(value.versions);
    setLoaded(true);
  };
  useEffect(() => {
    if (mode === "viewer") return;
    let current = true;
    void read()
      .then((value) => {
        if (current) {
          setVersions(value.versions);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (current) setError(failure(error));
      });
    return () => {
      current = false;
    };
  }, [read, mode, refreshKey]);
  const open = useCallback(
    (file: FileVersion) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      return readPreview(projectId, file, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          if (value.kind === "image") setImage(value.source);
          else {
            setPreview(value);
            setStart("0");
            setEnd(String([...value.text].length));
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(failure(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    },
    [projectId],
  );
  useEffect(() => {
    if (file) void open(file);
    return () => active.current?.abort();
  }, [file, open]);
  function select(file: FileVersion) {
    setBusy(true);
    setSelected(file);
    setPreview(undefined);
    setImage("");
    setRenderMarkdown(true);
    setError(undefined);
    setReport(undefined);
    void open(file);
  }
  return (
    <section className="files-panel">
      {mode !== "viewer" && (
        <>
          <h2 className="flex items-center gap-2">
            <Files size={17} aria-hidden="true" />
            {t("ファイルと生成物")}
          </h2>
          <label>
            {t("ファイルをアップロード")}
            <Upload
              size={14}
              className="ml-1 inline-block text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="file"
              disabled={readOnly || busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setBusy(true);
                setError(undefined);
                void (async () => {
                  const body = isMarkdownFile(file.name)
                    ? await markdownUpload(file, preferences.editorName)
                    : file;
                  await api(
                    `/api/projects/${projectId}/files?name=${encodeURIComponent(file.name)}`,
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": file.type || "application/octet-stream",
                      },
                      body,
                    },
                  );
                })()
                  .then(async () => {
                    await load();
                    await onChanged?.();
                  })
                  .catch((error) => setError(failure(error)))
                  .finally(() => setBusy(false));
                event.target.value = "";
              }}
            />
          </label>
          {loaded && versions.length === 0 && (
            <small>{t("ファイルはまだありません")}</small>
          )}
          <ul>
            {versions.map((file) => (
              <li key={file.id}>
                <button
                  disabled={busy}
                  onClick={() => (onOpen ? onOpen(file) : select(file))}
                >
                  <FileText
                    size={15}
                    className="shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>{file.name}</span>
                </button>
                <small>
                  {file.size} bytes · SHA256 {file.sha256}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p role="alert">{errorText(error, locale)}</p>}
      {selected && (
        <article>
          <h3>{selected.name}</h3>
          <p>
            {t("不変バージョン")} {selected.id} · SHA256 {selected.sha256}
          </p>
          <a
            href={`/api/projects/${projectId}/files/${selected.id}/download`}
            download
            className="inline-flex items-center gap-2 text-sm"
          >
            <Download size={15} aria-hidden="true" />
            {t("ファイルをダウンロード")}
          </a>
          <SourceReference
            projectId={projectId}
            kind="file"
            sourceId={selected.id}
          />
          {image && (
            <Image
              src={image}
              alt={selected.name}
              width={1024}
              height={768}
              unoptimized
              style={{ maxWidth: "100%", height: "auto", objectFit: "contain" }}
            />
          )}
          {preview && (
            <>
              {scientific && markdown && (
                <div
                  role="group"
                  aria-label={t("Markdownの表示")}
                  className="my-3 flex flex-wrap gap-2"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={renderMarkdown ? "outline" : "default"}
                    aria-pressed={!renderMarkdown}
                    onClick={() => setRenderMarkdown(false)}
                  >
                    {t("原文を表示")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={renderMarkdown ? "default" : "outline"}
                    aria-pressed={renderMarkdown}
                    onClick={() => setRenderMarkdown(true)}
                  >
                    {t("レンダリングを表示")}
                  </Button>
                </div>
              )}
              <ScientificView
                source={preview.text}
                enabled={scientific && markdown && renderMarkdown}
                projectId={projectId}
              />
              {preview.omittedBytes > 0 && (
                <p role="status">
                  {t("省略したバイト数")}: {preview.omittedBytes}
                </p>
              )}
              <p>
                {t(
                  "範囲は表示テキストの Unicode 文字位置（開始を含み、終了を含みません）。送信前に内容を再確認します。",
                )}
              </p>
              <label>
                {t("開始位置")}
                <input
                  type="number"
                  min={0}
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                />
              </label>
              <label>
                {t("終了位置")}
                <input
                  type="number"
                  min={1}
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                />
              </label>
              <button
                disabled={readOnly || busy}
                onClick={() => {
                  const a = Number(start),
                    b = Number(end);
                  if (
                    !Number.isSafeInteger(a) ||
                    !Number.isSafeInteger(b) ||
                    a < 0 ||
                    b <= a ||
                    b > [...preview.text].length
                  ) {
                    setError(
                      failure(new ClientError("INVALID_SELECTION_RANGE")),
                    );
                    return;
                  }
                  onShare({
                    kind: "file",
                    sourceId: selected.id,
                    start: a,
                    end: b,
                  });
                }}
              >
                {t("選択範囲をチャットへ")}
              </button>
              <button
                disabled={readOnly || busy}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  const target = {
                    kind: "file",
                    id: selected.id,
                    sha256: selected.sha256,
                  };
                  void api<{ fingerprint: string }>(
                    `/api/projects/${projectId}/checks/preview`,
                    json({ target }),
                  )
                    .then((preview) =>
                      api<CheckReport>(
                        `/api/projects/${projectId}/checks`,
                        json({
                          target,
                          fingerprint: preview.fingerprint,
                          requestId: crypto.randomUUID(),
                        }),
                      ),
                    )
                    .then(setReport)
                    .catch((error) => setError(failure(error)))
                    .finally(() => setBusy(false));
                }}
              >
                {t("ローカルチェック")}
              </button>
            </>
          )}
          {report && (
            <aside>
              <h3>{t("科学的妥当性は未検証")}</h3>
              <p>
                {t(
                  "参照と実行記録のローカル検査です。数値一致・因果・再現性の証明ではありません。",
                )}
              </p>
              <pre>{JSON.stringify(report, null, 2)}</pre>
            </aside>
          )}
        </article>
      )}
    </section>
  );
}

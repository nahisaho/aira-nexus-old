"use client";
import { useEffect, useState } from "react";
import {
  Globe2,
  Palette,
  Plug,
  RotateCcw,
  Save,
  Stethoscope,
  Trash2,
} from "lucide-react";
import type { ProjectChat } from "../server/sessions";
import type { Readiness } from "../server/diagnostics";
import type {
  IntegrationRegistry,
  IntegrationSettings,
} from "../server/integration-catalog";
import { api, json, failure, errorText, ClientError } from "./client-api";
import { Modal } from "./modal";
import { useAppearance, useText } from "./appearance";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { validEditorName } from "../lib/markdown-metadata";
/** @id CODE-LAYOUT-SETTINGS @implements REQ-LAYOUT-003 REQ-LAYOUT-004 REQ-MARKDOWN-003 REQ-DIAG-003 */
export function WorkspaceSettings({
  projectId,
  readOnly,
  onClose,
  onChanged,
}: {
  projectId?: string;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { preferences, update } = useAppearance();
  const { t, locale } = useText();
  const [registry, setRegistry] = useState<IntegrationRegistry>();
  const [settings, setSettings] = useState<IntegrationSettings>();
  const [deleted, setDeleted] = useState<ProjectChat[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Readiness>();
  const [diagnosticError, setDiagnosticError] = useState<Error>();
  const [editorName, setEditorName] = useState(preferences.editorName);
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      api<IntegrationRegistry>("/api/integrations", options),
      api<{ projects: ProjectChat[] }>("/api/projects/deleted", options),
      projectId
        ? api<IntegrationSettings>(
            `/api/projects/${projectId}/integrations`,
            options,
          )
        : Promise.resolve(undefined),
    ])
      .then(([registry, deleted, selections]) => {
        if (controller.signal.aborted) return;
        setRegistry(registry);
        setDeleted(deleted.projects);
        setSettings(selections);
        setLoaded(true);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(failure(error));
      });
    return () => controller.abort();
  }, [projectId]);
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await run();
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  async function runDiagnostics() {
    setBusy(true);
    setDiagnosticError(undefined);
    setDiagnostics(undefined);
    try {
      setDiagnostics(await api<Readiness>("/api/readiness"));
    } catch (error) {
      setDiagnosticError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  function appearance(kind: "theme" | "locale", value: string) {
    try {
      if (kind === "theme" && (value === "light" || value === "dark"))
        update({ ...preferences, theme: value });
      else if (kind === "locale" && (value === "ja" || value === "en"))
        update({ ...preferences, locale: value });
      else throw new ClientError("INVALID_APPEARANCE");
    } catch (error) {
      setError(failure(error));
    }
  }
  return (
    <Modal title={t("AIRA Nexus の設定")} onClose={onClose} busy={busy}>
      <section className="settings-section">
        <h3 className="flex items-center gap-2">
          <Palette size={17} className="text-primary" aria-hidden="true" />
          {t("外観")}
        </h3>
        <div className="settings-fields">
          <label>
            <Globe2
              size={14}
              className="mr-1 inline-block"
              aria-hidden="true"
            />
            {t("テーマ")}
            <select
              aria-label={t("テーマ")}
              value={preferences.theme}
              onChange={(event) => appearance("theme", event.target.value)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            {t("表示言語")}
            <select
              aria-label={t("表示言語")}
              value={preferences.locale}
              onChange={(event) => appearance("locale", event.target.value)}
            >
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
      </section>
      <section className="settings-section">
        <h3>{t("編集者の表示名")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("編集者名は自己申告です。本人確認済みの履歴ではありません。")}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              if (!validEditorName(editorName))
                throw new ClientError("INVALID_EDITOR_NAME");
              update({ ...preferences, editorName: editorName.trim() });
              setError(undefined);
            } catch (error) {
              setError(failure(error));
            }
          }}
        >
          <label>
            {t("編集者名")}
            <Input
              aria-label={t("編集者名")}
              value={editorName}
              maxLength={80}
              required
              disabled={busy}
              onChange={(event) => setEditorName(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {t("編集者名を保存")}
          </Button>
        </form>
      </section>
      {error && <p role="alert">{errorText(error, locale)}</p>}
      {!loaded && !error && <p role="status">{t("読み込み中")}</p>}
      <section className="settings-section">
        <h3 className="flex items-center gap-2">
          <Stethoscope size={17} className="text-primary" aria-hidden="true" />
          {t("診断")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(
            "認証はローカルの Copilot CLI で設定してください。ブラウザに認証情報を入力しないでください。",
          )}
        </p>
        <Button disabled={busy} onClick={() => void runDiagnostics()}>
          <Stethoscope aria-hidden="true" />
          {t("診断を実行")}
        </Button>
        {diagnosticError && (
          <p role="alert">{errorText(diagnosticError, locale)}</p>
        )}
        {diagnostics !== undefined && (
          <pre aria-label={t("診断結果")}>
            {JSON.stringify(diagnostics, null, 2)}
          </pre>
        )}
      </section>
      <section className="settings-section">
        <h3 className="flex items-center gap-2">
          <Plug size={17} className="text-primary" aria-hidden="true" />
          Agents · Skills · MCP
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("これらの選択はチャットに適用されません。")}
        </p>
        {registry && (
          <>
            <p>
              <code>
                {registry.source.repository}@{registry.source.commit}
              </code>
            </p>
            <label>
              {t("カタログを検索")}
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {!projectId && (
              <p>{t("プロジェクトを選択すると連携設定を保存できます。")}</p>
            )}
            {readOnly && <p>{t("アーカイブ済み・読み取り専用")}</p>}
            {(["agents", "skills", "mcp"] as const).map((kind) => {
              const entries = registry[kind].filter((entry) =>
                `${entry.name} ${entry.id} ${entry.path}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              );
              return (
                <fieldset key={kind} disabled={!settings || readOnly || busy}>
                  <legend>
                    {kind === "agents"
                      ? "Agents"
                      : kind === "skills"
                        ? "Skills"
                        : "MCP"}
                  </legend>
                  {kind === "agents" && registry.agents.length === 0 && (
                    <p>
                      {t("この固定ソースには個別の Agent 定義がありません。")}
                    </p>
                  )}
                  {kind !== "agents" && entries.length === 0 && (
                    <p>{t("該当する項目はありません")}</p>
                  )}
                  <div className="catalog-entries">
                    {entries.map((entry) => (
                      <div key={entry.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={
                              settings?.selections[kind].includes(entry.id) ??
                              false
                            }
                            onChange={(event) => {
                              if (!settings) return;
                              const ids = settings.selections[kind];
                              setSettings({
                                ...settings,
                                selections: {
                                  ...settings.selections,
                                  [kind]: event.target.checked
                                    ? [...ids, entry.id]
                                    : ids.filter((id) => id !== entry.id),
                                },
                              });
                              setSaved(false);
                            }}
                          />
                          {entry.name}
                        </label>
                        <small>
                          <code>{entry.id}</code> · {entry.path}
                        </small>
                      </div>
                    ))}
                  </div>
                </fieldset>
              );
            })}
            <Button
              disabled={!settings || !projectId || readOnly || busy}
              onClick={() =>
                void act(async () => {
                  if (!settings || !projectId)
                    throw new ClientError("PROJECT_REQUIRED");
                  const value = await api<IntegrationSettings>(
                    `/api/projects/${projectId}/integrations`,
                    {
                      ...json({
                        revision: settings.revision,
                        selections: settings.selections,
                      }),
                      method: "PUT",
                    },
                  );
                  setSettings(value);
                  setSaved(true);
                })
              }
            >
              <Save aria-hidden="true" />
              {t("選択を保存")}
            </Button>
            {saved && <p role="status">{t("選択を保存しました")}</p>}
          </>
        )}
      </section>
      <section className="settings-section">
        <h3 className="flex items-center gap-2">
          <Trash2 size={17} className="text-primary" aria-hidden="true" />
          {t("削除したプロジェクト")}
        </h3>
        {loaded && deleted.length === 0 && (
          <p>{t("削除したプロジェクトはありません")}</p>
        )}
        {deleted.map((project) => (
          <p key={project.id}>
            {project.name}{" "}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`${t("復元")} ${project.name}`}
              onClick={() =>
                void act(async () => {
                  await api(
                    `/api/projects/${project.id}/restore`,
                    json({ revision: project.revision }),
                  );
                  await onChanged();
                  setDeleted(
                    (
                      await api<{ projects: ProjectChat[] }>(
                        "/api/projects/deleted",
                      )
                    ).projects,
                  );
                })
              }
            >
              <RotateCcw aria-hidden="true" />
              {t("復元")}
            </Button>
          </p>
        ))}
      </section>
    </Modal>
  );
}

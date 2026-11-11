"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  Eye,
  MessageSquareText,
  UserRound,
} from "lucide-react";
import type { Chat, ChatPreview } from "../server/chat";
import type { ExcerptSelection } from "../server/chat-context";
import type { TurnProjection } from "../server/sse";
import { api, json, failure, ClientError, errorText } from "./client-api";
import { useText } from "./appearance";
import { ConfirmationPanel } from "./confirmation-panel";
import { ScientificView } from "./scientific-view";
import { SourceReference } from "./source-reference";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Skeleton } from "./ui/skeleton";
/** @id CODE-UI-CHAT @implements REQ-UI-001 REQ-UI-002 REQ-UI-003 */
export function ChatPanel({
  projectId,
  readOnly,
  scientific,
  selections,
  onClearSelections,
  onChanged,
}: {
  projectId: string;
  readOnly: boolean;
  scientific: boolean;
  selections: ExcerptSelection[];
  onClearSelections: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t, locale } = useText();
  const [chat, setChat] = useState<Awaited<ReturnType<Chat["open"]>>>();
  const [prompt, setPrompt] = useState(""),
    [error, setError] = useState<Error>(),
    [sent, setSent] = useState(false);
  const [pending, setPending] = useState<{
    preview: ChatPreview;
    prompt: string;
    selections: ExcerptSelection[];
    requestId: string;
  }>();
  const [busy, setBusy] = useState(false);
  const read = useCallback(
    () =>
      api<Awaited<ReturnType<Chat["open"]>>>(`/api/projects/${projectId}/chat`),
    [projectId],
  );
  const load = async () => {
    const value = await read();
    setChat(value);
  };
  useEffect(() => {
    void read()
      .then(setChat)
      .catch((error) => setError(failure(error)));
  }, [read]);
  return (
    <section className="chat-panel" aria-busy={!chat && !error}>
      <div className="chat-heading">
        <div className="chat-avatar">
          <Bot size={20} aria-hidden="true" />
        </div>
        <div>
          <h2>{chat?.project.chatTitle ?? t("チャット")}</h2>
          <p>
            {t("過去の会話と今回選択した範囲だけを、送信前に確認できます。")}
          </p>
        </div>
      </div>
      {!chat && !error && (
        <div role="status">
          <p>{t("読み込み中")}</p>
          <Skeleton className="mb-2 h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}
      {chat && chat.history.turns.length === 0 && (
        <div className="chat-empty">
          <MessageSquareText size={28} aria-hidden="true" />
          <h3>{t("最初の問いから、研究を始めましょう。")}</h3>
          <p>{t("仮説の整理やコードの相談など、研究について質問できます。")}</p>
        </div>
      )}
      {chat?.history.turns.map((turn) => (
        <article className="chat-turn" key={turn.id}>
          <div className="chat-question">
            <h3>
              <UserRound size={14} aria-hidden="true" />
              {t("相談")}
            </h3>
            <pre>{turn.prompt}</pre>
          </div>
          <div className="chat-response">
            <h3>
              <Bot size={14} aria-hidden="true" />
              {t("応答")}
            </h3>
            <ScientificView
              source={turn.response}
              enabled={scientific}
              projectId={projectId}
            />
            {Array.from(
              turn.response.matchAll(/\[(file|run):([a-f0-9-]{36})\]/g),
              (match, index) => (
                <SourceReference
                  key={`${match[0]}-${index}`}
                  projectId={projectId}
                  kind={match[1] === "file" ? "file" : "run"}
                  sourceId={match[2]}
                />
              ),
            )}
          </div>
        </article>
      ))}
      {chat &&
        (chat.history.omittedComplete > 0 ||
          chat.history.omittedIncomplete > 0) && (
          <p role="status">
            {t("履歴省略")}: {t("完了")} {chat.history.omittedComplete} ·{" "}
            {t("未完了")} {chat.history.omittedIncomplete}
          </p>
        )}
      {selections.length > 0 && (
        <aside className="shared-excerpts">
          <h3>{t("今回だけ共有する選択範囲")}</h3>
          <pre>{JSON.stringify(selections, null, 2)}</pre>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onClearSelections}
          >
            {t("選択範囲を解除")}
          </Button>
        </aside>
      )}
      <div className="chat-composer">
        <label>
          {t("メッセージ")}
          <Textarea
            placeholder={t("研究について相談する…")}
            value={prompt}
            disabled={readOnly || busy}
            onChange={(event) => {
              setPrompt(event.target.value);
              setPending(undefined);
            }}
          />
        </label>
        <div className="composer-footer">
          <small>
            <Eye size={14} aria-hidden="true" />
            {t("送信前に共有内容を確認します")}
          </small>
          <Button
            disabled={readOnly || busy || !prompt.trim()}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              setSent(false);
              void api<ChatPreview>(
                `/api/projects/${projectId}/chat/context`,
                json({ prompt, selections }),
              )
                .then((preview) =>
                  setPending({
                    preview,
                    prompt,
                    selections: [...selections],
                    requestId: crypto.randomUUID(),
                  }),
                )
                .catch((error) => setError(failure(error)))
                .finally(() => setBusy(false));
            }}
          >
            {t("送信内容を確認")}
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </div>
      </div>
      {error && <p role="alert">{errorText(error, locale)}</p>}
      {sent && <p role="status">{t("送信完了")}</p>}
      {pending && (
        <ConfirmationPanel
          title={t("外部送信する内容")}
          payload={pending.preview.context.wire}
          onReject={async () => {
            setPending(undefined);
          }}
          onApprove={async () => {
            const turn = await api<TurnProjection>(
              `/api/projects/${projectId}/chat/turns`,
              json({
                prompt: pending.prompt,
                selections: pending.selections,
                grantId: pending.preview.grantId,
                fingerprint: pending.preview.context.fingerprint,
                requestId: pending.requestId,
              }),
            );
            if (turn.state !== "completed")
              throw new ClientError("SEND_INCOMPLETE", undefined, turn.state);
            setPending(undefined);
            setPrompt("");
            onClearSelections();
            setSent(true);
            await load();
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

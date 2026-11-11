"use client";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ClientError, failure, errorText } from "./client-api";
import { useText } from "./appearance";
export interface SourceReferenceProps {
  projectId: string;
  kind: "file" | "run" | "cell";
  sourceId: string;
}
const responseSchema = z
  .object({
    kind: z.enum(["file", "run"]),
    token: z.string(),
  })
  .passthrough();
/** @id CODE-CITE-CARD @implements REQ-CITE-001 REQ-CITE-003 */
export function SourceReference(props: SourceReferenceProps) {
  return (
    <SourceReferenceCard
      key={JSON.stringify([props.projectId, props.kind, props.sourceId])}
      {...props}
    />
  );
}
function SourceReferenceCard(props: SourceReferenceProps) {
  const { t, locale } = useText();
  const [record, setRecord] = useState<{
    text: string;
    omittedBytes: number;
  }>();
  const [error, setError] = useState<Error>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const unresolved = props.kind === "cell";
  const endpoint = `/api/projects/${encodeURIComponent(props.projectId)}/sources/${props.kind}/${encodeURIComponent(props.sourceId)}`;
  async function act(copy: boolean) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    setCopied(false);
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok)
        throw new ClientError("SOURCE_REFERENCE_FAILED", response.status);
      const value: unknown = await response.json();
      const parsed = responseSchema.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.kind !== props.kind ||
        parsed.data.token !== `[${props.kind}:${props.sourceId.toLowerCase()}]`
      )
        throw new ClientError("REFERENCE_ID_MISMATCH");
      controller.signal.throwIfAborted();
      if (copy) {
        await navigator.clipboard.writeText(parsed.data.token);
        setCopied(true);
      } else {
        const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
        const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          bytes.subarray(0, 65536),
          { stream: true },
        );
        setRecord({
          text,
          omittedBytes: bytes.length - new TextEncoder().encode(text).length,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("SOURCE_REFERENCE_FAILED");
        setError(failure(error));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <article
      data-citation-id={`${props.kind}:${props.sourceId}`}
      aria-busy={busy}
    >
      <code>{`[${props.kind}:${props.sourceId}]`}</code>
      <p>
        {t(
          "保存時点の参照です。現在のセルや科学的妥当性の証明とは区別してください。",
        )}
      </p>
      {unresolved && (
        <p role="alert">
          {t("セルだけの参照では、保存時点の実行記録を特定できません。")}
        </p>
      )}
      <button
        type="button"
        disabled={unresolved || busy}
        onClick={() => void act(false)}
      >
        {t("参照を開く")}
      </button>
      <button
        type="button"
        disabled={unresolved || busy}
        onClick={() => void act(true)}
      >
        {t("引用をコピー")}
      </button>
      {error && <p role="alert">{errorText(error, locale)}</p>}
      {copied && <p role="status">{t("コピーしました")}</p>}
      {record && (
        <>
          <pre>{record.text}</pre>
          {record.omittedBytes > 0 && (
            <p>
              {t("省略したバイト数")}: {record.omittedBytes}
            </p>
          )}
          <a href={endpoint} download>
            {t("完全な記録をJSONで保存")}
          </a>
        </>
      )}
    </article>
  );
}

"use client";
import { useEffect, useState } from "react";
import type { ScientificView as View } from "../server/scientific-rendering";
import { api, json, failure, errorText } from "./client-api";
import { useText } from "./appearance";
import { ScientificHtml } from "./scientific-html";
/** @id CODE-UI-RENDER @implements REQ-UI-003 */
export function ScientificView({
  source,
  enabled,
  projectId,
}: {
  source: string;
  enabled: boolean;
  projectId: string;
}) {
  const { t, locale } = useText();
  const [view, setView] = useState<View>(),
    [error, setError] = useState<Error>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void api<View>("/api/render", {
      ...json({ source, projectId }),
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setView(value);
          setError(undefined);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(failure(error));
      });
    return () => controller.abort();
  }, [source, enabled, projectId]);
  if (!enabled || view?.raw !== source)
    return (
      <>
        <pre>{source}</pre>
        {error && <p role="alert">{errorText(error, locale)}</p>}
      </>
    );
  return (
    <>
      <ScientificHtml html={view.html} locale={locale} />
      {view.omittedBytes > 0 && (
        <p role="status">
          {t("省略したバイト数")}: {view.omittedBytes}
        </p>
      )}
      {view.errors.map((error, index) => (
        <p role="alert" key={index}>
          {error.kind}: {error.message}
        </p>
      ))}
    </>
  );
}

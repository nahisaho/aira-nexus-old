"use client";
import { useEffect, useRef } from "react";
import { ClientError, failure } from "./client-api";
import { text, type Locale } from "./messages";

let mermaid: Promise<(typeof import("mermaid"))["default"]> | undefined;
let sequence = 0;
function renderer() {
  return (mermaid ??= import("mermaid").then(({ default: library }) => {
    library.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      layout: "dagre",
      fontFamily: "sans-serif",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      maxTextSize: 8192,
      maxEdges: 100,
      suppressErrorRendering: true,
      secure: [
        "securityLevel",
        "startOnLoad",
        "layout",
        "fontFamily",
        "htmlLabels",
        "flowchart",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "themeCSS",
      ],
    });
    return library;
  }));
}

export function ScientificHtml({
  html,
  locale,
}: {
  html: string;
  locale: Locale;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let disposed = false;
    const urls: string[] = [];
    const cleanup: (() => void)[] = [];
    for (const image of root.querySelectorAll("img")) {
      let error: HTMLSpanElement | undefined;
      const failed = () => {
        if (error || disposed) return;
        console.error("SCIENTIFIC_IMAGE_FAILED");
        error = document.createElement("span");
        error.setAttribute("role", "alert");
        error.textContent = `${text(locale, "画像を表示できません")}: ${image.alt}`;
        image.after(error);
      };
      image.addEventListener("error", failed);
      if (image.complete && !image.naturalWidth) failed();
      cleanup.push(() => {
        image.removeEventListener("error", failed);
        error?.remove();
      });
    }
    const codes = root.querySelectorAll("pre > code.language-mermaid");
    for (const [index, code] of codes.entries()) {
      const pre = code.parentElement;
      if (!pre) continue;
      const source = code.textContent ?? "";
      void (async () => {
        try {
          if (index >= 10 || new TextEncoder().encode(source).length > 8192)
            throw new ClientError("MERMAID_BUDGET_EXCEEDED");
          if (
            /%%\{|^\s*---|^\s*click\b|https?:|file:|data:|javascript:|\/\/|url\s*\(|<\s*\/?[a-z]|@\{/im.test(
              source,
            )
          )
            throw new ClientError("MERMAID_SOURCE_BLOCKED");
          const library = await renderer();
          if (disposed) return;
          const measurement = document.createElement("div");
          measurement.style.cssText =
            "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none";
          document.body.append(measurement);
          let svg: string;
          try {
            ({ svg } = await library.render(
              `aira-mermaid-${++sequence}`,
              source,
              measurement,
            ));
          } finally {
            measurement.remove();
          }
          if (disposed) return;
          const blob = new Blob([svg], { type: "image/svg+xml" });
          if (blob.size > 1024 * 1024)
            throw new ClientError("MERMAID_OUTPUT_BUDGET_EXCEEDED");
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const image = new Image();
          image.alt = text(locale, "Mermaid図");
          image.src = url;
          await image.decode();
          if (disposed) return;
          const figure = document.createElement("figure");
          figure.className = "mermaid-diagram";
          figure.dataset.mermaid = "ready";
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = text(locale, "図のソース");
          details.append(summary);
          figure.append(image, details);
          pre.replaceWith(figure);
          details.append(pre);
          cleanup.push(() => {
            if (figure.isConnected) figure.replaceWith(pre);
          });
        } catch (error) {
          if (disposed) return;
          failure(error);
          const message = document.createElement("p");
          message.setAttribute("role", "alert");
          message.textContent = `${text(locale, "Mermaid図を表示できません")} (${error instanceof ClientError ? error.code : "MERMAID_RENDER_FAILED"})`;
          pre.after(message);
          cleanup.push(() => message.remove());
        }
      })();
    }
    return () => {
      disposed = true;
      for (const release of cleanup) release();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [html, locale]);
  return (
    <div
      ref={container}
      className="scientific"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

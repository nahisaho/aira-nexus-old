import type { ScientificView } from "../server/scientific-rendering";
/** @id CODE-RENDER-VIEW @implements REQ-RENDER-001 REQ-RENDER-003 */
export function ScientificText({ view }: { view: ScientificView }) {
  const group = useId();
  return (
    <section className="scientific-text">
      <details name={group} open data-display="raw">
        <summary>原文</summary>
        <pre>{view.raw}</pre>
      </details>
      <details name={group} data-display="scientific">
        <summary>科学表示</summary>
        <div dangerouslySetInnerHTML={{ __html: view.html }} />
      </details>
      {view.omittedBytes > 0 && (
        <p role="status">
          科学表示では {view.omittedBytes} バイトを省略しました。
        </p>
      )}
    </section>
  );
}
import { useId } from "react";

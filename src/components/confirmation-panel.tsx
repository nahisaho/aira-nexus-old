"use client";
import { useState } from "react";
import { Check, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { failure, errorText } from "./client-api";
import { Modal } from "./modal";
import { useText } from "./appearance";
import { Button } from "./ui/button";
/** @id CODE-UI-CONFIRM @implements REQ-UI-002 */
export function ConfirmationPanel({
  title,
  payload,
  onApprove,
  onReject,
  returnFocus,
}: {
  title: string;
  payload: unknown;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  returnFocus?: HTMLElement;
}) {
  const { t, locale } = useText();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      onClose={() => void act(onReject)}
      busy={busy}
      closeButton={false}
      returnFocus={returnFocus}
    >
      <div className="flex items-start gap-3">
        <ShieldCheck
          className="mt-1 size-5 shrink-0 text-primary"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">
          {t("下記の内容だけを今回承認します。拒否しても送信・実行しません。")}
        </p>
      </div>
      <pre className="confirmation-payload">
        {typeof payload === "string"
          ? payload
          : JSON.stringify(payload, null, 2)}
      </pre>
      {error && <p role="alert">{errorText(error, locale)}</p>}
      <div className="dialog-actions">
        <Button disabled={busy} onClick={() => void act(onApprove)}>
          {busy ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
          {t("承認して実行")}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void act(onReject)}
        >
          <X aria-hidden="true" />
          {t("拒否")}
        </Button>
      </div>
      {busy && <p role="status">{t("処理中")}</p>}
    </Modal>
  );
}

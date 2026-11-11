"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useText } from "./appearance";
import { Button } from "./ui/button";
export function Modal({
  title,
  children,
  onClose,
  busy = false,
  closeButton = true,
  returnFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  closeButton?: boolean;
  returnFocus?: HTMLElement;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { t } = useText();
  useEffect(() => {
    const element = dialog.current;
    const previous = returnFocus ?? document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [returnFocus]);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        {closeButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("閉じる")}
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {children}
    </dialog>
  );
}

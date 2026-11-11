export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (!response.ok) {
    const value: unknown = await response.json();
    const code =
      value &&
      typeof value === "object" &&
      "code" in value &&
      typeof value.code === "string"
        ? value.code
        : "REQUEST_FAILED";
    throw new ClientError(code, response.status);
  }
  return response.json();
}
export function json(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}
export function failure(error: unknown) {
  console.error("WORKSPACE_ACTION_FAILED");
  return error instanceof Error ? error : new ClientError("ACTION_FAILED");
}
const codes: Record<string, Message> = {
  STALE_INTEGRATION_REVISION:
    "設定が更新されています。再読み込みしてから保存してください。",
  STALE_PROJECT_REVISION:
    "プロジェクトが更新されています。再読み込みしてください。",
  PROJECT_BUSY:
    "処理中のチャットまたは実行があります。完了後に再試行してください。",
  PROJECT_ARCHIVED: "アーカイブ済み・読み取り専用",
  INVALID_SELECTION_RANGE: "選択範囲が不正です",
  NOTEBOOK_REQUIRED: "Notebook を選択してください",
  NOTEBOOK_BUSY: "Notebook の処理が完了するまでお待ちください。",
  NO_PLAIN_RESULT: "共有できるプレーンテキストの実行結果がありません",
  SEND_INCOMPLETE: "送信は完了していません",
  EXECUTION_INCOMPLETE: "実行は完了していません",
  REFERENCE_ID_MISMATCH: "参照の識別情報が一致しません",
};
export function errorText(error: Error, locale: Locale) {
  const status = error instanceof ClientError ? error.status : undefined;
  const code = error instanceof ClientError ? error.code : error.message;
  const key =
    codes[code] ??
    (status === 404
      ? "対象が見つからないか、このプロジェクトでは参照できません。"
      : status === 409
        ? "競合が発生しました。再読み込みして確認してください。"
        : status === 400 || status === 413
          ? "入力内容を確認してください。"
          : status === 403
            ? "この操作は許可されていません。"
            : status && status >= 500
              ? "サービスを利用できません。診断を確認してください。"
              : "操作に失敗しました");
  return `${text(locale, key)} (${code}${status ? ` · HTTP ${status}` : ""})${error instanceof ClientError && error.detail ? `: ${error.detail}` : ""}`;
}
import { text, type Locale, type Message } from "./messages";
export class ClientError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(code);
  }
}

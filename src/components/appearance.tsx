"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { text, type Locale, type Message } from "./messages";
import { validEditorName } from "../lib/markdown-metadata";
type Preferences = Readonly<{
  theme: "light" | "dark";
  locale: Locale;
  editorName: string;
}>;
const defaults: Preferences = {
  theme: "light",
  locale: "ja",
  editorName: "local",
};
const key = "aira-nexus.appearance";
const unavailable = "PREFERENCES_UNAVAILABLE";
const defaultSnapshot = JSON.stringify(defaults);
function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener("aira-appearance", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("aira-appearance", notify);
  };
}
function snapshot() {
  try {
    return localStorage.getItem(key) ?? defaultSnapshot;
  } catch (error) {
    if (error instanceof DOMException) return unavailable;
    throw error;
  }
}
function decode(raw: string): { preferences: Preferences; error?: Message } {
  if (raw !== unavailable) {
    try {
      const value: unknown = JSON.parse(raw);
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) =>
          ["theme", "locale", "editorName"].includes(key),
        ) &&
        "theme" in value &&
        "locale" in value &&
        (value.theme === "light" || value.theme === "dark") &&
        (value.locale === "ja" || value.locale === "en") &&
        (!("editorName" in value) ||
          (typeof value.editorName === "string" &&
            validEditorName(value.editorName)))
      )
        return {
          preferences: {
            theme: value.theme,
            locale: value.locale,
            editorName:
              "editorName" in value && typeof value.editorName === "string"
                ? value.editorName.trim()
                : defaults.editorName,
          },
        };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return {
    preferences: defaults,
    error: "表示設定を読み込めません。標準設定を使用しています。",
  };
}
function update(preferences: Preferences) {
  localStorage.setItem(key, JSON.stringify(preferences));
  window.dispatchEvent(new Event("aira-appearance"));
}
const Appearance = createContext<{
  preferences: Preferences;
  update: (value: Preferences) => void;
  error?: Message;
}>({
  preferences: defaults,
  update() {
    throw new Error("APPEARANCE_PROVIDER_REQUIRED");
  },
});
/** @id CODE-LAYOUT-APPEARANCE @implements REQ-LAYOUT-003 REQ-MARKDOWN-003 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const raw = useSyncExternalStore(subscribe, snapshot, () => defaultSnapshot);
  const value = useMemo(() => ({ ...decode(raw), update }), [raw]);
  useEffect(() => {
    document.documentElement.dataset.theme = value.preferences.theme;
    document.documentElement.lang = value.preferences.locale;
    if (value.error) console.error("PREFERENCES_INVALID_OR_UNAVAILABLE");
  }, [value]);
  return <Appearance.Provider value={value}>{children}</Appearance.Provider>;
}
export function useAppearance() {
  return useContext(Appearance);
}
export function useText() {
  const {
    preferences: { locale },
  } = useAppearance();
  return { locale, t: (key: Message) => text(locale, key) };
}

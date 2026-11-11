"use client";
import {
  ArrowUpRight,
  Atom,
  Files,
  MessageSquareText,
  NotebookPen,
  Plus,
} from "lucide-react";
import { useText } from "./appearance";
import { Button } from "./ui/button";

export function Welcome({
  onCreate,
}: {
  onCreate: (returnFocus: HTMLElement) => void;
}) {
  const { t } = useText();
  return (
    <div className="welcome">
      <section className="welcome-hero">
        <div className="welcome-mark">
          <Atom size={30} aria-hidden="true" />
        </div>
        <span className="eyebrow">AI for Science</span>
        <h1>{t("研究を、ひとつのワークスペースに。")}</h1>
        <p className="welcome-description">
          {t(
            "アイデアの相談から、ノートブックでの検証、研究データの整理まで。プロジェクトごとに、思考と記録をつなぎます。",
          )}
        </p>
        <div className="welcome-actions">
          <Button size="lg" onClick={(event) => onCreate(event.currentTarget)}>
            <Plus aria-hidden="true" />
            {t("新しい研究を始める")}
            <ArrowUpRight aria-hidden="true" />
          </Button>
          <small>{t("プロジェクトを選択または追加してください。")}</small>
        </div>
      </section>
      <div className="feature-grid">
        <article className="feature-card">
          <div className="feature-icon">
            <MessageSquareText size={20} aria-hidden="true" />
          </div>
          <h2>{t("会話から研究を深める")}</h2>
          <p>
            {t(
              "AIとアイデアを整理。共有する情報は、送信する前に自分で確認できます。",
            )}
          </p>
        </article>
        <article className="feature-card">
          <div className="feature-icon">
            <NotebookPen size={20} aria-hidden="true" />
          </div>
          <h2>{t("考察と検証をつなぐ")}</h2>
          <p>
            {t(
              "コード、数式、考察をNotebookに。実行内容を確認してから検証を進めます。",
            )}
          </p>
        </article>
        <article className="feature-card">
          <div className="feature-icon">
            <Files size={20} aria-hidden="true" />
          </div>
          <h2>{t("研究の根拠を残す")}</h2>
          <p>
            {t(
              "ファイルと実行記録をプロジェクトに集約。参照元をたどりながら研究を進められます。",
            )}
          </p>
        </article>
      </div>
    </div>
  );
}

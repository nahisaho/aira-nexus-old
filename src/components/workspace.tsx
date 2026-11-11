"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import {
  Archive,
  Atom,
  ChevronRight,
  Clock3,
  FileText,
  FolderClosed,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  NotebookPen,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import type { ProjectChat } from "../server/sessions";
import type { ExcerptSelection } from "../server/chat-context";
import type { Proposal } from "../server/proposals";
import type { Notebooks } from "../server/notebooks";
import type { FileVersion } from "../server/files";
import { api, json, failure, errorText, ClientError } from "./client-api";
import { ChatPanel } from "./chat-panel";
import { NotebookEditor } from "./notebook-editor";
import { FilesPanel } from "./files-panel";
import { ConfirmationPanel } from "./confirmation-panel";
import { WorkspaceSettings } from "./workspace-settings";
import { Modal } from "./modal";
import { useAppearance, useText } from "./appearance";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Skeleton } from "./ui/skeleton";
import { Welcome } from "./welcome";
type Book = Awaited<ReturnType<Notebooks["list"]>>[number];
type Viewer = { id: string; generation: number } & (
  | { kind: "file"; file: FileVersion }
  | {
      kind: "notebook";
      book: Pick<Book, "id" | "name">;
      onDirtyChange: (id: string, value: boolean) => void;
      onBusyChange: (value: boolean) => void;
    }
);
type ViewerActivity = { dirty: boolean; busy: boolean };
const fixedTabs = [
  { id: "chat", label: "AI Chat", icon: MessageSquareText },
  { id: "lab-note", label: "実験ノート", icon: NotebookPen },
] as const;
type Action =
  | { kind: "create"; returnFocus?: HTMLElement }
  | {
      kind: "edit";
      project: ProjectChat;
      returnFocus?: HTMLElement;
    };
// Keep pane openness across responsive resizing; do not overwrite a user's toggles.
let firstWidth: number | undefined;
const initialWidth = () => (firstWidth ??= window.innerWidth);
const subscribeWidth = () => () => {};
/** @id CODE-UI-WORKSPACE @implements REQ-UI-001 REQ-UI-003 REQ-LAYOUT-001 REQ-LAYOUT-002 REQ-LAYOUT-004 REQ-LAYOUT-005 REQ-LAYOUT-006 */
export function Workspace({ projectId }: { projectId?: string }) {
  const { t, locale } = useText();
  const appearance = useAppearance();
  const width = useSyncExternalStore(subscribeWidth, initialWidth, () => 1100);
  const [leftOpen, setLeftOpen] = useState<boolean>();
  const [rightOpen, setRightOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectChat[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [pinning, setPinning] = useState<string>();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const openViewers = useRef(new Map<string, Viewer>());
  const nextViewer = useRef(0);
  const activityNow = useRef(
    new Map<number, ViewerActivity>([[0, { dirty: false, busy: false }]]),
  );
  const [activity, setActivity] = useState<Record<number, ViewerActivity>>({
    0: { dirty: false, busy: false },
  });
  const [managerBusy, setManagerBusy] = useState(false);
  const [accepting, setAccepting] = useState<Proposal>();
  const [active, setActive] = useState("chat");
  const [selections, setSelections] = useState<ExcerptSelection[]>([]);
  const [error, setError] = useState<Error>();
  const [action, setAction] = useState<Action>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [settings, setSettings] = useState(false);
  const [pending, setPending] = useState<Proposal>();
  const [archiving, setArchiving] = useState<{
    project: ProjectChat;
    returnFocus?: HTMLElement;
  }>();
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [guard, setGuard] = useState<{
    run: () => void;
    discard: () => void;
  }>();
  const [menu, setMenu] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtons = useRef(new Map<string, HTMLButtonElement>());
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const projectToggle = useRef<HTMLButtonElement>(null);
  const explorerToggle = useRef<HTMLButtonElement>(null);
  const allowLeave = useRef(false);
  const project = projects.find((item) => item.id === projectId);
  const readOnly = project?.status === "archived";
  const isDirty = Object.values(activity).some((value) => value.dirty);
  const mutating =
    managerBusy ||
    Boolean(accepting) ||
    Object.values(activity).some((value) => value.busy);
  const query = projectSearch
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase(locale);
  const matchingProjects = projects.filter((item) =>
    `${item.name}\n${item.description}`
      .normalize("NFKC")
      .toLocaleLowerCase(locale)
      .includes(query),
  );
  const read = useCallback(async () => {
    const [list, changes] = await Promise.all([
      api<{ projects: ProjectChat[] }>("/api/projects"),
      projectId
        ? api<{ proposals: Proposal[] }>(`/api/projects/${projectId}/proposals`)
        : Promise.resolve({ proposals: [] }),
    ]);
    return {
      projects: list.projects,
      proposals: changes.proposals,
    };
  }, [projectId]);
  const apply = useCallback(
    (value: { projects: ProjectChat[]; proposals: Proposal[] }) => {
      setProjects(value.projects);
      setProjectsLoaded(true);
      setProposals(value.proposals);
      setRefreshKey((value) => value + 1);
    },
    [],
  );
  const load = useCallback(async () => apply(await read()), [read, apply]);
  useEffect(() => {
    const visit = projectId
      ? api<ProjectChat>(`/api/projects/${projectId}/visit`, json({}))
      : Promise.resolve();
    void visit
      .then(read)
      .then(apply)
      .catch((error) => setError(failure(error)));
  }, [read, apply, projectId]);
  useEffect(() => {
    if (!isDirty && !mutating) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (allowLeave.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty, mutating]);
  useEffect(
    () => () => {
      openViewers.current.clear();
      activityNow.current.clear();
    },
    [],
  );
  useEffect(() => {
    tabButtons.current.get(active)?.focus();
  }, [active]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !menuButtons.current.get(menu)?.contains(event.target)
      )
        setMenu(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const changeActivity = useCallback(
    (generation: number, patch: Partial<ViewerActivity>) => {
      const current = activityNow.current.get(generation);
      if (!current) return;
      const next = { ...current, ...patch };
      if (next.dirty === current.dirty && next.busy === current.busy) return;
      activityNow.current.set(generation, next);
      setActivity((current) => ({ ...current, [generation]: next }));
    },
    [],
  );
  const journalDirty = useCallback(
    (_id: string, dirty: boolean) => changeActivity(0, { dirty }),
    [changeActivity],
  );
  const journalBusy = useCallback(
    (busy: boolean) => changeActivity(0, { busy }),
    [changeActivity],
  );
  function blockMutation() {
    if (
      !managerBusy &&
      !accepting &&
      ![...activityNow.current.values()].some((value) => value.busy)
    )
      return false;
    setError(new ClientError("NOTEBOOK_BUSY"));
    return true;
  }
  function guarded(run: () => void, discard = () => {}, blocked = isDirty) {
    if (blocked) setGuard({ run, discard });
    else run();
  }
  function navigate(href: string) {
    if (blockMutation()) return;
    guarded(() => leave(href));
  }
  // Full document navigation keeps Back/Forward covered by the unload guard.
  function leave(href: string) {
    allowLeave.current = true;
    window.location.assign(new URL(href, window.location.origin).href);
  }
  function link(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    if (href === `/projects/${projectId}`) {
      setLeftOpen(false);
      return;
    }
    navigate(href);
  }
  function openFile(file: FileVersion) {
    const id = `file-${file.id}`;
    if (!openViewers.current.has(id)) {
      openViewers.current.set(id, {
        id,
        kind: "file",
        file,
        generation: ++nextViewer.current,
      });
      setViewers([...openViewers.current.values()]);
    }
    setActive(id);
    setRightOpen(false);
  }
  function openNotebook(book: Pick<Book, "id" | "name">) {
    const id = `notebook-${book.id}`;
    if (!openViewers.current.has(id)) {
      const generation = ++nextViewer.current;
      const state = { dirty: false, busy: false };
      activityNow.current.set(generation, state);
      setActivity((current) => ({ ...current, [generation]: state }));
      openViewers.current.set(id, {
        id,
        kind: "notebook",
        book,
        generation,
        onDirtyChange: (_id, dirty) => changeActivity(generation, { dirty }),
        onBusyChange: (busy) => changeActivity(generation, { busy }),
      });
      setViewers([...openViewers.current.values()]);
    }
    setActive(id);
    setRightOpen(false);
  }
  function share(selection: ExcerptSelection) {
    setSelections([selection]);
    setActive("chat");
  }
  function close(viewer: Viewer) {
    if (openViewers.current.get(viewer.id)?.generation !== viewer.generation)
      return;
    if (viewerBusy(viewer)) return;
    guarded(
      () => {
        const current = [...openViewers.current.values()];
        const index = current.findIndex((item) => item.id === viewer.id);
        openViewers.current.delete(viewer.id);
        activityNow.current.delete(viewer.generation);
        setActivity((current) => {
          const next = { ...current };
          delete next[viewer.generation];
          return next;
        });
        const remaining = [...openViewers.current.values()];
        setViewers(remaining);
        setActive((selected) =>
          selected === viewer.id
            ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? "chat")
            : selected,
        );
      },
      () => {},
      Boolean(activityNow.current.get(viewer.generation)?.dirty),
    );
  }
  function viewerBusy(viewer: Viewer) {
    return Boolean(
      activityNow.current.get(viewer.generation)?.busy ||
      (viewer.kind === "notebook" &&
        accepting &&
        "notebookId" in accepting.action &&
        accepting.action.notebookId === viewer.book.id),
    );
  }
  function move(id: string, target: string) {
    const current = [...openViewers.current.values()];
    const from = current.findIndex((item) => item.id === id);
    const to = current.findIndex((item) => item.id === target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...current],
      [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    openViewers.current = new Map(next.map((viewer) => [viewer.id, viewer]));
    setViewers(next);
  }
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const ids: string[] = [
      ...fixedTabs.map((tab) => tab.id),
      ...viewers.map((item) => item.id),
    ];
    const index = ids.indexOf(id);
    if (
      event.altKey &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      const target = ids[index + (event.key === "ArrowLeft" ? -1 : 1)];
      if (target) move(id, target);
      setActive(id);
      return;
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? ids.length - 1
          : event.key === "ArrowRight"
            ? (index + 1) % ids.length
            : event.key === "ArrowLeft"
              ? (index + ids.length - 1) % ids.length
              : -1;
    if (next >= 0) {
      event.preventDefault();
      setActive(ids[next]);
      tabButtons.current.get(ids[next])?.focus();
    }
    if (event.key === "Delete") {
      const viewer = viewers.find((item) => item.id === id);
      if (viewer) {
        event.preventDefault();
        close(viewer);
      }
    }
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    const index = items.findIndex((item) => item === document.activeElement);
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : event.key === "ArrowUp"
              ? (index + items.length - 1) % items.length
              : -1;
    if (target >= 0) {
      event.preventDefault();
      event.stopPropagation();
      items[target]?.focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (menu) menuButtons.current.get(menu)?.focus();
      setMenu(undefined);
    }
    if (event.key === "Tab") setMenu(undefined);
  }
  function projectAction(item: ProjectChat) {
    const next: Action = {
      kind: "edit",
      project: item,
      returnFocus: menuButtons.current.get(item.id),
    };
    setMenu(undefined);
    setName(item.name);
    setDescription(item.description);
    setError(undefined);
    setAction(next);
  }
  async function pinProject(item: ProjectChat) {
    setMenu(undefined);
    setPinning(item.id);
    setError(undefined);
    try {
      const updated = await api<ProjectChat>(
        `/api/projects/${item.id}/pin`,
        json({ pinned: !item.pinned }),
      );
      setProjects((current) =>
        current.map((project) =>
          project.id === updated.id ? updated : project,
        ),
      );
    } catch (error) {
      setError(failure(error));
    } finally {
      setPinning(undefined);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body)
          menuButtons.current.get(item.id)?.focus();
      });
    }
  }
  function archiveProject(item: ProjectChat) {
    setMenu(undefined);
    if (item.id === projectId && blockMutation()) return;
    guarded(
      () =>
        setArchiving({
          project: item,
          returnFocus: menuButtons.current.get(item.id),
        }),
      () => {},
      item.id === projectId && isDirty,
    );
  }
  async function editProject() {
    if (!action) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action.kind === "create") {
        const created = await api<ProjectChat>(
          "/api/projects",
          json({ name, description }),
        );
        leave(`/projects/${created.id}`);
      } else {
        await api(`/api/projects/${action.project.id}`, {
          ...json({ name, description, revision: action.project.revision }),
          method: "PATCH",
        });
        await load();
        setAction(undefined);
      }
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }
  function createProject(returnFocus: HTMLElement) {
    if (blockMutation()) return;
    guarded(() => {
      setName("");
      setDescription("");
      setError(undefined);
      setAction({ kind: "create", returnFocus });
    });
  }
  return (
    <main className="workspace">
      <header className="app-header">
        <Link
          href="/"
          className="brand"
          prefetch={false}
          onClick={(event) => link(event, "/")}
        >
          <span className="brand-mark">
            <Atom size={24} aria-hidden="true" />
          </span>
          <span>AIRA Nexus</span>
        </Link>
        <div className="header-context">
          <span>{t("ローカル研究ワークスペース")}</span>
          {project && (
            <>
              <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              <span>{project.name}</span>
            </>
          )}
        </div>
        <div className="mobile-controls">
          <Button
            variant="ghost"
            size="icon"
            ref={projectToggle}
            aria-label={t("プロジェクトペインを切り替え")}
            aria-controls="projects-pane"
            aria-expanded={leftOpen ?? width >= 960}
            onClick={() => {
              setLeftOpen(!(leftOpen ?? width >= 960));
              setRightOpen(false);
            }}
          >
            <Menu aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            ref={explorerToggle}
            aria-label={t("エクスプローラーを切り替え")}
            aria-controls="explorer-pane"
            aria-expanded={rightOpen}
            onClick={() => {
              setRightOpen(!rightOpen);
              setLeftOpen(false);
            }}
          >
            <PanelRight aria-hidden="true" />
          </Button>
        </div>
      </header>
      <div className="workspace-grid">
        <aside
          id="projects-pane"
          className={`projects-pane ${(leftOpen ?? width >= 960) ? "is-open" : ""}`}
          aria-label={t("プロジェクト管理")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setLeftOpen(false);
              projectToggle.current?.focus();
            }
          }}
        >
          <div className="pane-heading">
            <h2>{t("プロジェクト管理")}</h2>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("プロジェクトを追加")}
              onClick={(event) => createProject(event.currentTarget)}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
          <div className="project-search">
            <Search size={16} aria-hidden="true" />
            <Input
              type="search"
              aria-label={t("プロジェクトを検索")}
              placeholder={t("プロジェクトを検索")}
              value={projectSearch}
              onChange={(event) => {
                setProjectSearch(event.target.value);
                setMenu(undefined);
              }}
            />
          </div>
          <nav className="project-list" aria-label={t("研究プロジェクト")}>
            {!projectsLoaded && !error && (
              <div
                aria-label={t("プロジェクトを読み込み中")}
                className="space-y-3"
              >
                <Skeleton className="h-10 bg-white/10" />
                <Skeleton className="h-10 bg-white/10" />
                <Skeleton className="h-10 bg-white/10" />
              </div>
            )}
            {projectsLoaded && projects.length === 0 && (
              <div className="sidebar-empty">
                <p>{t("プロジェクトがありません")}</p>
                <p>{t("上の＋から研究プロジェクトを追加できます。")}</p>
              </div>
            )}
            {projectsLoaded &&
              projects.length > 0 &&
              matchingProjects.length === 0 && (
                <p className="sidebar-empty">
                  {t("該当するプロジェクトはありません")}
                </p>
              )}
            {(
              [
                { label: "ピン止め済み", pinned: true, icon: Pin },
                { label: "最近のプロジェクト", pinned: false, icon: Clock3 },
              ] as const
            ).map(({ label, pinned, icon: Icon }) => (
              <section
                key={label}
                aria-label={t(label)}
                className="project-group"
              >
                <h3>
                  <Icon size={13} aria-hidden="true" />
                  {t(label)}
                </h3>
                {matchingProjects
                  .filter((item) => item.pinned === pinned)
                  .map((item) => (
                    <div className="project-row" key={item.id}>
                      <a
                        href={`/projects/${item.id}`}
                        onClick={(event) => link(event, `/projects/${item.id}`)}
                        aria-current={
                          item.id === projectId ? "page" : undefined
                        }
                      >
                        {item.id === projectId ? (
                          <FolderOpen size={16} aria-hidden="true" />
                        ) : (
                          <FolderClosed size={16} aria-hidden="true" />
                        )}
                        <span>{item.name}</span>
                      </a>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        ref={(element) => {
                          if (element)
                            menuButtons.current.set(item.id, element);
                          else menuButtons.current.delete(item.id);
                        }}
                        aria-label={`${t("プロジェクトメニュー")} ${item.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menu === item.id}
                        disabled={Boolean(pinning)}
                        onClick={() =>
                          setMenu(menu === item.id ? undefined : item.id)
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key === "ArrowDown" ||
                            event.key === "ArrowUp"
                          ) {
                            event.preventDefault();
                            setMenu(item.id);
                          }
                        }}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                      {menu === item.id && (
                        <div
                          ref={menuRef}
                          role="menu"
                          aria-label={item.name}
                          className="project-menu"
                          onKeyDown={menuKeys}
                        >
                          <button
                            role="menuitem"
                            disabled={item.status === "archived"}
                            onClick={() => projectAction(item)}
                          >
                            <Pencil size={14} aria-hidden="true" />
                            {t("詳細を編集")}
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => void pinProject(item)}
                          >
                            {item.pinned ? (
                              <PinOff size={14} aria-hidden="true" />
                            ) : (
                              <Pin size={14} aria-hidden="true" />
                            )}
                            {t(item.pinned ? "ピン留めを解除" : "ピン留め")}
                          </button>
                          <button
                            role="menuitem"
                            disabled={
                              item.status === "archived" ||
                              (item.id === projectId && mutating)
                            }
                            onClick={() => archiveProject(item)}
                          >
                            <Archive size={14} aria-hidden="true" />
                            {t("アーカイブ")}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
              </section>
            ))}
          </nav>
          <div className="sidebar-footer">
            <Button
              className="settings-gear"
              type="button"
              variant="ghost"
              aria-label={t("AIRA Nexus の設定")}
              onClick={() => setSettings(true)}
            >
              <Settings2 aria-hidden="true" />
              <span>{t("AIRA Nexus の設定")}</span>
            </Button>
            <div className="sidebar-note">
              <HardDrive size={13} aria-hidden="true" />
              <span>{t("研究データはローカルに保存")}</span>
            </div>
          </div>
        </aside>
        <section
          className="workspace-center"
          role="region"
          aria-label={t("作業領域")}
        >
          {appearance.error && (
            <p role="alert">
              {t(appearance.error)} (PREFERENCES_INVALID_OR_UNAVAILABLE)
            </p>
          )}
          {error && !action && <p role="alert">{errorText(error, locale)}</p>}
          {!projectId && <Welcome onCreate={createProject} />}
          {project && (
            <>
              <div className="project-heading">
                <div>
                  <span className="eyebrow">{t("研究プロジェクト")}</span>
                  <h1>{project.name}</h1>
                  {project.description && <p>{project.description}</p>}
                </div>
                <Badge variant="outline" className="mt-2 gap-1.5">
                  <FolderOpen aria-hidden="true" />
                  {t("作業領域")}
                </Badge>
              </div>
              {readOnly && (
                <p role="status">{t("アーカイブ済み・読み取り専用")}</p>
              )}
              <div
                role="tablist"
                aria-label={t("作業領域")}
                className="viewer-tabs"
              >
                {fixedTabs.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    role="tab"
                    draggable={false}
                    id={`tab-${id}`}
                    aria-controls={`panel-${id}`}
                    aria-selected={active === id}
                    tabIndex={active === id ? 0 : -1}
                    ref={(element) => {
                      if (element) tabButtons.current.set(id, element);
                      else tabButtons.current.delete(id);
                    }}
                    onKeyDown={(event) => tabKeys(event, id)}
                    onClick={() => setActive(id)}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {t(label)}
                  </button>
                ))}
                {viewers.map((viewer) => (
                  <div className="viewer-tab" key={viewer.id}>
                    <button
                      role="tab"
                      id={`tab-${viewer.id}`}
                      aria-controls={`panel-${viewer.id}`}
                      aria-selected={active === viewer.id}
                      tabIndex={active === viewer.id ? 0 : -1}
                      draggable
                      onDragStart={(event) =>
                        event.dataTransfer.setData("text/plain", viewer.id)
                      }
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        move(
                          event.dataTransfer.getData("text/plain"),
                          viewer.id,
                        );
                      }}
                      ref={(element) => {
                        if (element) tabButtons.current.set(viewer.id, element);
                        else tabButtons.current.delete(viewer.id);
                      }}
                      onClick={() => setActive(viewer.id)}
                      onKeyDown={(event) => tabKeys(event, viewer.id)}
                    >
                      {viewer.kind === "notebook" ? (
                        <NotebookPen
                          size={14}
                          className="shrink-0"
                          aria-hidden="true"
                        />
                      ) : (
                        <FileText
                          size={14}
                          className="shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      {viewer.kind === "file"
                        ? viewer.file.name
                        : viewer.book.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t("タブを閉じる")} ${viewer.kind === "file" ? viewer.file.name : viewer.book.name}`}
                      disabled={viewerBusy(viewer)}
                      onClick={() => close(viewer)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              <div
                id="panel-chat"
                role="tabpanel"
                aria-labelledby="tab-chat"
                hidden={active !== "chat"}
                className="viewer-panel"
              >
                <ChatPanel
                  projectId={project.id}
                  readOnly={Boolean(readOnly)}
                  scientific
                  selections={selections}
                  onClearSelections={() => setSelections([])}
                  onChanged={load}
                />
              </div>
              <div
                id="panel-lab-note"
                role="tabpanel"
                aria-labelledby="tab-lab-note"
                hidden={active !== "lab-note"}
                className="viewer-panel"
              >
                <NotebookEditor
                  key={project.status}
                  projectId={project.id}
                  readOnly={Boolean(readOnly)}
                  scientific
                  onShare={share}
                  mode="journal"
                  refreshKey={refreshKey}
                  onDirtyChange={journalDirty}
                  onBusyChange={journalBusy}
                  onChanged={load}
                />
              </div>
              {viewers.map((viewer) => (
                <div
                  key={viewer.generation}
                  id={`panel-${viewer.id}`}
                  role="tabpanel"
                  aria-labelledby={`tab-${viewer.id}`}
                  hidden={active !== viewer.id}
                  className="viewer-panel"
                >
                  {viewer.kind === "file" ? (
                    <FilesPanel
                      projectId={project.id}
                      readOnly={Boolean(readOnly)}
                      scientific
                      onShare={share}
                      mode="viewer"
                      file={viewer.file}
                    />
                  ) : (
                    <NotebookEditor
                      projectId={project.id}
                      readOnly={Boolean(readOnly)}
                      scientific
                      onShare={share}
                      mode="viewer"
                      notebookId={viewer.book.id}
                      refreshKey={refreshKey}
                      onBusyChange={viewer.onBusyChange}
                      onDirtyChange={viewer.onDirtyChange}
                      onChanged={load}
                    />
                  )}
                </div>
              ))}
              <section
                className="proposals-panel"
                aria-label={t("AI の変更提案")}
              >
                <div className="flex items-center gap-2">
                  <h2 className="mb-0">{t("変更提案")}</h2>
                  <Badge variant="secondary">
                    {
                      proposals.filter((item) => item.state === "pending")
                        .length
                    }
                  </Badge>
                </div>
                <p>{t("適用後もコードは自動実行しません。")}</p>
                {proposals.every((item) => item.state !== "pending") && (
                  <small>{t("確認待ちの提案はありません")}</small>
                )}
                {proposals
                  .filter((item) => item.state === "pending")
                  .map((item) => (
                    <article className="proposal-card" key={item.id}>
                      <code>{item.id}</code>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={readOnly}
                        onClick={() => setPending(item)}
                      >
                        {t("提案を確認")}
                      </Button>
                    </article>
                  ))}
              </section>
            </>
          )}
          {projectId && !project && !error && (
            <div role="status">
              <p>{t("プロジェクトを読み込み中")}</p>
              <Skeleton className="mb-3 h-12" />
              <Skeleton className="h-48" />
            </div>
          )}
        </section>
        <aside
          id="explorer-pane"
          className={`explorer-pane ${rightOpen ? "is-open" : ""}`}
          aria-label={t("ファイルエクスプローラー")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setRightOpen(false);
              explorerToggle.current?.focus();
            }
          }}
        >
          <div className="pane-heading">
            <h2>{t("ファイルエクスプローラー")}</h2>
            <FolderSearch
              size={16}
              className="text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          {!project && (
            <div className="explorer-empty">
              <FolderSearch size={32} aria-hidden="true" />
              <p>
                {t(
                  "プロジェクトを選択すると、Notebookとファイルがここに表示されます。",
                )}
              </p>
            </div>
          )}
          {project && (
            <>
              <NotebookEditor
                projectId={project.id}
                readOnly={Boolean(readOnly)}
                scientific
                onShare={share}
                mode="manager"
                refreshKey={refreshKey}
                onBusyChange={setManagerBusy}
                onChanged={load}
                onOpen={openNotebook}
              />
              <FilesPanel
                projectId={project.id}
                readOnly={Boolean(readOnly)}
                scientific
                onShare={share}
                mode="explorer"
                refreshKey={refreshKey}
                onChanged={load}
                onOpen={openFile}
              />
            </>
          )}
        </aside>
      </div>
      {settings && (
        <WorkspaceSettings
          projectId={projectId}
          readOnly={Boolean(readOnly)}
          onClose={() => setSettings(false)}
          onChanged={load}
        />
      )}
      {action && (
        <Modal
          title={t(
            action.kind === "create" ? "プロジェクトを追加" : "詳細を編集",
          )}
          onClose={() => setAction(undefined)}
          busy={busy}
          returnFocus={action.returnFocus}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void editProject();
            }}
          >
            <label>
              {t("プロジェクト名")}
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
              />
            </label>
            <label>
              {t("説明")}
              <Textarea
                aria-label={t("説明")}
                className="field-sizing-fixed h-32 resize-none overflow-y-auto"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
              />
            </label>
            {error && <p role="alert">{errorText(error, locale)}</p>}
            <div className="dialog-actions">
              <Button disabled={busy}>
                {t(
                  action.kind === "create"
                    ? "プロジェクトを作成"
                    : "変更を保存",
                )}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {guard && (
        <Modal
          title={t("未保存の変更")}
          closeButton={false}
          onClose={() => setGuard(undefined)}
        >
          <p>
            {t(
              "未保存の編集を破棄しますか。保存するには編集を続けてください。",
            )}
          </p>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setGuard(undefined)}>
              {t("編集を続ける")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                guard.discard();
                guard.run();
                setGuard(undefined);
              }}
            >
              {t("変更を破棄")}
            </Button>
          </div>
        </Modal>
      )}
      {pending && project && (
        <ConfirmationPanel
          title={t("変更差分を確認")}
          payload={{ before: pending.before, after: pending.action }}
          onApprove={async () => {
            setAccepting(pending);
            try {
              await api(
                `/api/projects/${project.id}/proposals/${pending.id}/accept`,
                json({
                  revision:
                    pending.action.kind === "create-notebook"
                      ? 0
                      : pending.action.revision,
                }),
              );
              setPending(undefined);
              await load();
            } finally {
              setAccepting(undefined);
            }
          }}
          onReject={async () => {
            await api(
              `/api/projects/${project.id}/proposals/${pending.id}/reject`,
              json({}),
            );
            setPending(undefined);
            await load();
          }}
        />
      )}
      {archiving && (
        <ConfirmationPanel
          title={t("アーカイブを確認")}
          payload={archiving.project}
          returnFocus={archiving.returnFocus}
          onApprove={async () => {
            await api(
              `/api/projects/${archiving.project.id}/archive`,
              json({ revision: archiving.project.revision }),
            );
            if (archiving.project.id === projectId) {
              openViewers.current.clear();
              activityNow.current.clear();
              activityNow.current.set(0, { dirty: false, busy: false });
              setActivity({ 0: { dirty: false, busy: false } });
              setViewers([]);
              setActive("chat");
            }
            setArchiving(undefined);
            await load();
          }}
          onReject={async () => setArchiving(undefined)}
        />
      )}
    </main>
  );
}

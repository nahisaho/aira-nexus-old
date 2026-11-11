import { ServiceError } from "./http";
import type { Operations } from "./operations";
import type { Sessions } from "./sessions";
import type { Files } from "./files";
import type { Notebooks } from "./notebooks";
import type { Sources } from "./sources";
import type { Credentials } from "./credentials";
import pg from "pg";
import { z } from "zod";
import MarkdownIt from "markdown-it";
import { createHash, randomUUID } from "node:crypto";
import { databaseConfig } from "./database";
import { ownedProject, projectId as validId } from "./project-scope";
import { cellIdSchema, type RunEnvironment } from "./run-snapshots";
import { validText } from "./chat-context";
export type CheckTarget =
  | { kind: "file"; id: string; sha256: string }
  | { kind: "chat"; id: string; sha256: string }
  | { kind: "markdown"; notebookId: string; cellId: string; revision: number };
export type Verdict = "passed" | "warning" | "not_checked";
export interface CheckReport {
  id: string;
  jobId: string;
  target: CheckTarget;
  sourceSha256: string;
  checkerVersion: string;
  citedRuns: string[];
  linkage: {
    verdict: Verdict;
    claims: { text: string; line: number; runs: string[]; verdict: Verdict }[];
  };
  execution: {
    verdict: Verdict;
    runs: {
      id: string;
      verdict: Verdict;
      status: string;
      reason: string;
      environment: RunEnvironment | null;
    }[];
  };
  seeds: {
    verdict: "heuristic" | "not_checked";
    declarations: {
      runId: string;
      line: number;
      value: string;
      language: "python" | "r";
    }[];
    appliedOrReproduced: false;
  };
  scope: { examined: string[]; omitted: string[] };
}
export interface CheckServices {
  operations: Operations;
  sessions: Sessions;
  files: Files;
  notebooks: Notebooks;
  sources: Sources;
}
export interface CheckOptions {
  checkerVersion?: string;
  beforePublish?: () => Promise<void>;
}
const MAX_SOURCE_BYTES = 65536,
  MAX_RUN_REFERENCES = 32,
  MAX_ACTIVE_CHECKS = 4;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), id: uuid, sha256 }).strict(),
  z.object({ kind: z.literal("chat"), id: uuid, sha256 }).strict(),
  z
    .object({
      kind: z.literal("markdown"),
      notebookId: uuid,
      cellId: cellIdSchema,
      revision: z.number().int().positive(),
    })
    .strict(),
]);
const previewSchema = z.object({ target: targetSchema }).strict();
const requestSchema = previewSchema
  .extend({ requestId: uuid, fingerprint: sha256 })
  .strict();
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  maxNesting: 20,
});
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID_CHECK_REQUEST");
  return parsed.data;
}
interface Prose {
  claims: CheckReport["linkage"]["claims"];
  references: string[];
  omitted: string[];
}
function prose(source: string): Prose {
  const claims: Prose["claims"] = [],
    references = new Set<string>();
  const omitted = new Set<string>([
    "Code, DOI text, hyperlink/reference labels and destinations are not numerical prose.",
    "Linkage does not establish numeric agreement, units, causality or scientific correctness.",
    "Only literal line-based seed declarations are heuristic information; aliases and multiline syntax are not established.",
  ]);
  let tableDepth = 0;
  for (const token of markdown.parse(source, {})) {
    if (token.type === "table_open") {
      tableDepth++;
      omitted.add(
        "Table cells are omitted because their prose locations are not mapped.",
      );
    }
    if (token.type === "table_close") {
      tableDepth--;
      continue;
    }
    if (token.type !== "inline" || tableDepth) continue;
    if (!token.map || !token.children) {
      omitted.add("Unmapped inline prose is omitted.");
      continue;
    }
    const raw = token.content,
      visible = Array<string>(raw.length).fill("\0");
    let cursor = 0,
      mapped = true;
    for (const child of token.children) {
      if (child.type === "text") {
        if (!raw.startsWith(child.content, cursor)) {
          mapped = false;
          break;
        }
        for (let offset = 0; offset < child.content.length; offset++)
          visible[cursor + offset] = child.content[offset];
        cursor += child.content.length;
        continue;
      }
      if (child.type === "softbreak" || child.type === "hardbreak") {
        const span = /^[ \t]*\\?\n[ \t]*/.exec(raw.slice(cursor));
        if (!span) {
          mapped = false;
          break;
        }
        visible[cursor + span[0].indexOf("\n")] = "\n";
        cursor += span[0].length;
        continue;
      }
      if (
        /^(?:em|strong|s)_(?:open|close)$/.test(child.type) &&
        child.markup &&
        raw.startsWith(child.markup, cursor)
      ) {
        cursor += child.markup.length;
        continue;
      }
      if (
        child.type === "code_inline" &&
        /^`+$/.test(child.markup) &&
        raw.startsWith(child.markup, cursor)
      ) {
        const delimiters = /`+/g;
        delimiters.lastIndex = cursor + child.markup.length;
        let closing: RegExpExecArray | null;
        while ((closing = delimiters.exec(raw))) {
          if (closing[0].length !== child.markup.length) continue;
          let content = raw
            .slice(cursor + child.markup.length, closing.index)
            .replace(/\n/g, " ");
          if (
            content.startsWith(" ") &&
            content.endsWith(" ") &&
            /[^ ]/.test(content)
          )
            content = content.slice(1, -1);
          if (content === child.content) {
            cursor = closing.index + closing[0].length;
            break;
          }
          closing = null;
          break;
        }
        if (closing) continue;
      }
      mapped = false;
      break;
    }
    if (!mapped || cursor !== raw.length) {
      omitted.add(
        "Unmapped inline prose, including its run references, is omitted; escaped/entity text, links and images may prevent exact source mapping.",
      );
      continue;
    }
    let text = visible.join("");
    const paragraphRuns = [
      ...new Set(
        [...text.matchAll(/\[run:([^\]\n]{1,120})\]/gi)].map((match) =>
          match[1].toLowerCase(),
        ),
      ),
    ];
    for (const id of paragraphRuns) references.add(id);
    text = text
      .replace(/\[[^\]\n]*\]/g, (match) => "\0".repeat(match.length))
      .replace(/\b(?:doi:\s*)?10\.\d{4,9}\/[^\s\0]+/gi, (match) =>
        "\0".repeat(match.length),
      );
    const numeric =
      /\b(?:(?:AUROC|AUPRC|F1|accuracy|precision|recall|MAE|RMSE|MSE|R2)\s*=\s*\d+\.\d+|p(?:-value)?\s*(?:<=|>=|=|<|>)\s*\d+(?:\.\d+)?|n\s*=\s*\d+)(?![\w%]|\.\d)/gi;
    for (const match of text.matchAll(numeric))
      claims.push({
        text: match[0],
        line:
          token.map[0] +
          1 +
          (raw.slice(0, match.index).match(/\n/g)?.length ?? 0),
        runs: paragraphRuns,
        verdict: "warning",
      });
  }
  if (references.size > MAX_RUN_REFERENCES)
    omitted.add(
      `Run-reference limit ${MAX_RUN_REFERENCES}: ${references.size - MAX_RUN_REFERENCES} references omitted; linkage cannot certify omitted references.`,
    );
  return { claims, references: [...references], omitted: [...omitted] };
}
interface Evidence {
  id: string;
  found: boolean;
  status: string;
  source: string;
  language: "python" | "r";
  environment: RunEnvironment | null;
  errorOutput: boolean;
}
interface Capture {
  target: CheckTarget;
  source: string;
  sourceSha256: string;
  checkerVersion: string;
  prose: Prose;
  runs: Evidence[];
}
interface Prior {
  id: string;
  projectId: string | null;
  purpose: string;
  state: string;
  intentHash: string | null;
  capture: Capture | null;
  report: CheckReport | null;
}
function verdict(values: Verdict[]): Verdict {
  return values.includes("warning")
    ? "warning"
    : !values.length || values.includes("not_checked")
      ? "not_checked"
      : "passed";
}
function unsupportedLiteral(source: string) {
  if (source.includes('"""') || source.includes("'''") || source.includes("`"))
    return true;
  let quote = "",
    escaped = false,
    comment = false;
  for (const char of source) {
    if (char === "\n") {
      if (quote) return true;
      comment = false;
      continue;
    }
    if (comment) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === "#") comment = true;
    else if (char === "'" || char === '"') quote = char;
  }
  return false;
}
function reportFor(jobId: string, capture: Capture): CheckReport {
  const byId = new Map(capture.runs.map((run) => [run.id, run]));
  const claims = capture.prose.claims.map((claim) => ({
    ...claim,
    verdict:
      claim.runs.length && claim.runs.every((id) => byId.get(id)?.found)
        ? ("passed" as const)
        : ("warning" as const),
  }));
  const runs = capture.runs.map((run) => {
    const environment = run.environment;
    const available =
      !!environment?.imageDigest &&
      !!environment.python &&
      !!environment.r &&
      Object.keys(environment.packages).length > 0 &&
      Object.values(environment.packages).every((value) => !!value);
    const state: Verdict = !run.found
      ? "not_checked"
      : run.status !== "completed" || run.errorOutput
        ? "warning"
        : available
          ? "passed"
          : "not_checked";
    return {
      id: run.id,
      verdict: state,
      status: run.status,
      environment: run.environment,
      reason: !run.found
        ? "Owned immutable run unavailable; imported outputs are not execution proof."
        : state === "warning"
          ? "Run is noncompleted or has a recorded error output; warning stderr alone is not failure."
          : !available
            ? "Observed Python/R/package/image metadata is incomplete."
            : "Recorded completion without error outputs and observed environment metadata.",
    };
  });
  const declarations: CheckReport["seeds"]["declarations"] = [],
    omitted = [...capture.prose.omitted];
  for (const run of capture.runs) {
    if (!run.found) continue;
    if (unsupportedLiteral(run.source)) {
      omitted.push(
        `Run ${run.id}: seed inspection omitted for unsupported quoted/multiline syntax.`,
      );
      continue;
    }
    const pattern =
      run.language === "r"
        ? /^\s*set\.seed\(\s*(-?\d+)\s*\)\s*(?:#.*)?$/
        : /^\s*(?:[A-Za-z_]\w*\s*=\s*)?(?:random\.seed|np\.random\.seed|np\.random\.default_rng)\(\s*(-?\d+)\s*\)\s*(?:#.*)?$/;
    for (const [index, line] of run.source.split(/\r?\n/).entries()) {
      const match = pattern.exec(line);
      if (match)
        declarations.push({
          runId: run.id,
          line: index + 1,
          value: match[1],
          language: run.language,
        });
    }
  }
  return {
    id: randomUUID(),
    jobId,
    target: capture.target,
    sourceSha256: capture.sourceSha256,
    checkerVersion: capture.checkerVersion,
    citedRuns: capture.prose.references,
    linkage: {
      verdict: claims.length
        ? verdict(claims.map((claim) => claim.verdict))
        : "not_checked",
      claims,
    },
    execution: { verdict: verdict(runs.map((run) => run.verdict)), runs },
    seeds: {
      verdict: declarations.length ? "heuristic" : "not_checked",
      declarations,
      appliedOrReproduced: false,
    },
    scope: {
      examined: [
        `Canonical captured UTF-8 snapshot (${Buffer.byteLength(capture.source)} bytes).`,
        "Mapped prose: decimal metric assignments, p comparisons and integer n claims; same-paragraph run linkage.",
        `${capture.runs.length} captured owned run-reference lookups; recorded states, error outputs and observed environment availability.`,
        "Literal declarations in cited immutable Python/R source only.",
      ],
      omitted,
    },
  };
}
/** @id CODE-CHECK-REPORT @implements REQ-CHECK-001 REQ-CHECK-002 REQ-CHECK-003 REQ-CHECK-004 */
export class ResearchChecks {
  private readonly pool: pg.Pool;
  private readonly checkerVersion: string;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly services: CheckServices,
    state: string,
    credentials: Credentials,
    private readonly options: CheckOptions = {},
  ) {
    this.checkerVersion = validText(
      options.checkerVersion ?? "aira-checker-1",
      80,
    );
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () =>
      console.error("CHECK_DATABASE_CONNECTION_LOST"),
    );
  }
  private scope(actor: string, projectId: string) {
    validText(actor, 120);
    validId(projectId);
    return projectId.toLowerCase();
  }
  private async target(actor: string, projectId: string, target: CheckTarget) {
    let source: string;
    if (target.kind === "file") {
      const file = await this.services.files.get(actor, projectId, target.id);
      if (file.sha256 !== target.sha256)
        throw new ServiceError(409, "CHECK_TARGET_CHANGED");
      if (file.size > MAX_SOURCE_BYTES)
        throw new ServiceError(413, "CHECK_SOURCE_TOO_LARGE");
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of this.services.files.storage.read(file.blobId)) {
        size += part.length;
        if (size > file.size)
          throw new ServiceError(503, "FILE_INTEGRITY_ERROR");
        parts.push(Buffer.from(part));
      }
      const bytes = Buffer.concat(parts, size);
      if (
        size !== file.size ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      )
        throw new ServiceError(503, "FILE_INTEGRITY_ERROR");
      try {
        source = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch (error) {
        if (error instanceof TypeError)
          throw new ServiceError(400, "CHECK_TARGET_NOT_TEXT");
        throw error;
      }
    } else if (target.kind === "chat") {
      const turn = await this.services.sessions.turn(
        actor,
        projectId,
        target.id,
      );
      if (turn.state !== "completed" || digest(turn.response) !== target.sha256)
        throw new ServiceError(409, "CHECK_TARGET_CHANGED");
      source = turn.response;
    } else {
      const notebook = await this.services.notebooks.get(
        actor,
        projectId,
        target.notebookId,
      );
      if (notebook.revision !== target.revision)
        throw new ServiceError(409, "CHECK_TARGET_CHANGED");
      const cell = notebook.document.cells.find(
        (cell) => cell.id === target.cellId,
      );
      if (!cell || cell.cell_type !== "markdown")
        throw new ServiceError(400, "CHECK_TARGET_NOT_MARKDOWN");
      source = cell.source;
    }
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES)
      throw new ServiceError(413, "CHECK_SOURCE_TOO_LARGE");
    if (/[\u0000\uD800-\uDFFF]/u.test(source))
      throw new ServiceError(400, "CHECK_TARGET_NOT_TEXT");
    return { source, sourceSha256: digest(source) };
  }
  private fingerprint(
    projectId: string,
    target: CheckTarget,
    sourceSha256: string,
  ) {
    return digest(
      JSON.stringify({
        projectId,
        target,
        sourceSha256,
        checkerVersion: this.checkerVersion,
      }),
    );
  }
  private async prior(
    client: pg.Pool | pg.Client,
    actor: string,
    requestId: string,
  ): Promise<Prior | undefined> {
    return (
      await client.query<Prior>(
        `SELECT j.id,j.project_id AS "projectId",j.purpose,j.state,
      c.intent_hash AS "intentHash",c.capture,r.report
      FROM jobs j LEFT JOIN research_check_requests c ON c.job_id=j.id
      LEFT JOIN research_check_reports r ON r.job_id=j.id WHERE j.actor=$1 AND j.request_id=$2`,
        [actor, requestId],
      )
    ).rows[0];
  }
  private match(prior: Prior, projectId: string, intentHash: string) {
    if (
      prior.projectId !== projectId ||
      prior.purpose !== "check" ||
      prior.intentHash !== intentHash
    )
      throw new ServiceError(409, "REQUEST_INTENT_CONFLICT");
  }
  private async fenced<T>(action: (client: pg.Client) => Promise<T>) {
    try {
      return await this.services.operations.write(action);
    } catch (error) {
      if (
        error instanceof ServiceError &&
        ["WRITER_LEASE_UNAVAILABLE", "WRITER_FENCE_REJECTED"].includes(
          error.code,
        )
      )
        throw new ServiceError(409, "CHECK_WRITER_CHANGED");
      throw error;
    }
  }
  async preview(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<{
    fingerprint: string;
    target: CheckTarget;
    sourceSha256: string;
  }> {
    projectId = this.scope(actor, projectId);
    const { target } = parse(previewSchema, input);
    const project = await ownedProject(this.pool, actor, projectId);
    if (project.status !== "active")
      throw new ServiceError(409, "PROJECT_ARCHIVED");
    const captured = await this.target(actor, projectId, target);
    return {
      target,
      sourceSha256: captured.sourceSha256,
      fingerprint: this.fingerprint(projectId, target, captured.sourceSha256),
    };
  }
  /** @id CODE-VIS-CHECK-FENCE @implements REQ-VIS-001 REQ-VIS-002 */
  async run(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<CheckReport> {
    projectId = this.scope(actor, projectId);
    const value = parse(requestSchema, input);
    await ownedProject(this.pool, actor, projectId);
    const intentHash = digest(JSON.stringify({ actor, projectId, ...value }));
    const prior = await this.prior(this.pool, actor, value.requestId);
    if (prior) {
      this.match(prior, projectId, intentHash);
      if (prior.report) return prior.report;
    }
    const admitted = await this.fenced(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      const existing = await this.prior(client, actor, value.requestId);
      if (existing) {
        this.match(existing, projectId, intentHash);
        if (existing.report) return { report: existing.report };
        if (
          !existing.capture ||
          existing.capture.checkerVersion !== this.checkerVersion ||
          existing.state !== "running"
        )
          throw new ServiceError(409, "CHECK_REQUEST_NOT_RESUMABLE");
        return { jobId: existing.id, capture: existing.capture };
      }
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      const busy = await client.query(
        `SELECT count(*)::integer AS count FROM jobs j JOIN projects p ON p.id=j.project_id
        WHERE j.actor=$1 AND j.purpose='check' AND j.state IN ('queued','running')
        AND p.status='active' AND p.hidden_at IS NULL`,
        [actor],
      );
      if (busy.rows[0].count >= MAX_ACTIVE_CHECKS)
        throw new ServiceError(429, "CHECK_CAPACITY");
      const captured = await this.target(actor, projectId, value.target);
      if (
        value.fingerprint !==
        this.fingerprint(projectId, value.target, captured.sourceSha256)
      )
        throw new ServiceError(409, "CHECK_TARGET_CHANGED");
      const parsed = prose(captured.source),
        runs: Evidence[] = [];
      for (const id of parsed.references.slice(0, MAX_RUN_REFERENCES)) {
        if (z.uuid().safeParse(id).success) {
          try {
            const record = await this.services.sources.resolve(
              actor,
              projectId,
              "run",
              id,
            );
            if (record.kind !== "run")
              throw new ServiceError(503, "CHECK_RUN_INTEGRITY_ERROR");
            const run = record.snapshot;
            runs.push({
              id,
              found: true,
              source: run.source,
              language: run.language,
              status: run.status,
              environment: run.environment,
              errorOutput:
                run.outputs?.some((output) => output.output_type === "error") ??
                false,
            });
            continue;
          } catch (error) {
            if (!(error instanceof ServiceError && error.status === 404))
              throw error;
          }
        }
        runs.push({
          id,
          found: false,
          source: "",
          language: "python",
          status: "unavailable",
          environment: null,
          errorOutput: false,
        });
      }
      const capture: Capture = {
        ...captured,
        target: value.target,
        checkerVersion: this.checkerVersion,
        prose: parsed,
        runs,
      };
      const job = await this.services.operations.admitInTransaction(
        client,
        {
          actor,
          requestId: value.requestId,
          purpose: "check",
          fingerprint: value.fingerprint,
        },
        projectId,
      );
      await client.query(
        "INSERT INTO research_check_requests(job_id,actor,project_id,intent_hash,capture) VALUES($1,$2,$3,$4,$5)",
        [job.id, actor, projectId, intentHash, JSON.stringify(capture)],
      );
      await client.query(
        "UPDATE jobs SET state='running',started='observed' WHERE id=$1 AND state='queued'",
        [job.id],
      );
      return { jobId: job.id, capture };
    });
    if (admitted.report) return admitted.report;
    const report = reportFor(admitted.jobId, admitted.capture);
    await this.options.beforePublish?.();
    const published = await this.fenced(async (client) => {
      const current = await this.prior(client, actor, value.requestId);
      if (!current) throw new ServiceError(503, "CHECK_CAPTURE_MISSING");
      this.match(current, projectId, intentHash);
      const project = await ownedProject(client, actor, projectId, true, true);
      const visibility = await client.query<{ hidden: boolean }>(
        "SELECT hidden_at IS NOT NULL AS hidden FROM projects WHERE id=$1",
        [projectId],
      );
      if (visibility.rows[0].hidden) {
        if (!current.report)
          await this.services.operations.finishInTransaction(
            client,
            actor,
            admitted.jobId,
            "failed",
          );
        return { report: null, hidden: true };
      }
      if (current.report) return { report: current.report, hidden: false };
      if (project.status !== "active") {
        await this.services.operations.finishInTransaction(
          client,
          actor,
          admitted.jobId,
          "failed",
        );
        return { report: null, hidden: false };
      }
      await this.services.operations.finishInTransaction(
        client,
        actor,
        admitted.jobId,
        "completed",
      );
      await client.query(
        "INSERT INTO research_check_reports(id,job_id,actor,project_id,report) VALUES($1,$2,$3,$4,$5)",
        [report.id, admitted.jobId, actor, projectId, JSON.stringify(report)],
      );
      return { report, hidden: false };
    });
    if (!published.report)
      throw new ServiceError(
        published.hidden ? 404 : 409,
        published.hidden ? "PROJECT_NOT_FOUND" : "PROJECT_ARCHIVED",
      );
    return published.report;
  }
  async get(
    actor: string,
    projectId: string,
    id: string,
  ): Promise<CheckReport> {
    projectId = this.scope(actor, projectId);
    validId(id);
    await ownedProject(this.pool, actor, projectId);
    const result = await this.pool.query<{ report: CheckReport }>(
      "SELECT report FROM research_check_reports WHERE id=$1 AND actor=$2 AND project_id=$3",
      [id, actor, projectId],
    );
    if (result.rowCount !== 1)
      throw new ServiceError(404, "CHECK_REPORT_NOT_FOUND");
    return result.rows[0].report;
  }
  close(): Promise<void> {
    return (this.closing ??= this.pool.end());
  }
}

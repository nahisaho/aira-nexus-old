import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Notebooks, NotebookDocument, JsonValue } from "./notebooks";
import { cellIdSchema, outputsSchema, sharingSchema, type SharedVariable } from "./run-snapshots";
import { ServiceError } from "./http";
const BODY_LIMIT = 12 * 1024 ** 2, DISPLAY_LIMIT = 2 * 1024 ** 2;
const object = z.record(z.string(), z.json());
const source = z.union([z.string(), z.array(z.string())]).transform(value => typeof value === "string" ? value : value.join(""));
const outputList = z.array(z.unknown()).transform(values => values.map(value => {
  const stream = z.object({ output_type: z.literal("stream"), name: z.enum(["stdout", "stderr"]), text: z.array(z.string()) }).strict().safeParse(value);
  return stream.success ? { ...stream.data, text: stream.data.text.join("") } : value;
})).pipe(outputsSchema);
const common = { id: cellIdSchema.optional(), source, metadata: object };
const cellSchema = z.discriminatedUnion("cell_type", [
  z.object({ ...common, cell_type: z.literal("code"), outputs: outputList, execution_count: z.number().int().nonnegative().nullable() }).strict(),
  z.object({ ...common, cell_type: z.enum(["markdown", "raw"]), attachments: z.record(z.string(), object).optional() }).strict(),
]);
const documentSchema = z.object({ nbformat: z.literal(4), nbformat_minor: z.number().int().min(0).max(5), metadata: object, cells: z.array(cellSchema) }).strict();
const settings = z.object({ language: z.enum(["python", "r"]), sharing: sharingSchema }).strict();
const importedOrigin = z.object({ kind: z.literal("imported"), executed: z.literal(false), native_run_id: z.null(), external_execution_count: z.number().int().nonnegative().nullable() }).strict();
const generatedSchema = z.object({ id: cellIdSchema, source: z.string(), metadata: object, outputs: outputsSchema, origin: importedOrigin }).strict();
const historySchema = z.object({ version: z.literal(1), document_metadata: object, generated: z.array(generatedSchema).max(1) }).strict();
const descriptor = settings.extend({ wrapper: z.literal(1), source: z.string() }).strict();
const bootstrapDescriptor = z.object({ bootstrap: z.literal(1), bridge_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Wire = z.infer<typeof documentSchema>;
type History = z.infer<typeof historySchema>;
const reserved = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
function invalid(code = "INVALID_EXCHANGE"): never { throw new ServiceError(400, code); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { const result = schema.safeParse(value); if (!result.success) invalid(); return result.data; }
  catch (error) { if (error instanceof RangeError) invalid(); throw error; }
}
function unicode(text: string) {
  if (/[\uD800-\uDFFF]/u.test(text)) invalid("INVALID_EXCHANGE_UNICODE");
}
function sourceBudget(text: string) {
  unicode(text);
  if (Buffer.byteLength(text) > 65536) throw new ServiceError(413, "EXCHANGE_SOURCE_TOO_LARGE");
}
function selected(value: unknown): SharedVariable[] {
  const result = parse(sharingSchema, value);
  for (const entry of result)
    if (!/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(entry.name) || reserved.has(entry.name)) invalid("INVALID_SHARED_VARIABLE");
  return result;
}
function displayBudget(cells: { cell_type: string; outputs?: unknown; attachments?: unknown }[]) {
  const total = cells.reduce((sum, cell) => sum + Buffer.byteLength(JSON.stringify(cell.cell_type === "code" ? cell.outputs : [])) + Buffer.byteLength(JSON.stringify(cell.cell_type === "code" ? {} : cell.attachments ?? {})), 0);
  if (total > DISPLAY_LIMIT) throw new ServiceError(413, "EXCHANGE_DISPLAY_TOO_LARGE");
}
function defaultLanguage(metadata: Record<string, JsonValue>): "python" | "r" {
  const info = metadata.language_info === undefined ? undefined : parse(z.object({ name: z.string() }).passthrough(), metadata.language_info).name;
  const kernel = metadata.kernelspec === undefined ? undefined : parse(z.object({ name: z.string(), display_name: z.string(), language: z.string().optional() }).passthrough(), metadata.kernelspec);
  const named = kernel?.name === "ir" ? "r" : ["python", "python3"].includes(kernel?.name ?? "") ? "python" : undefined;
  const values = [info, kernel?.language, named].filter((value): value is string => value !== undefined).map(value => parse(z.enum(["python", "r"]), value.toLowerCase()));
  if (new Set(values).size > 1 || (!values.length && kernel)) invalid("UNKNOWN_EXCHANGE_LANGUAGE");
  return values[0] ?? "python";
}
function wrapper(language: "python" | "r", code: string, sharing: SharedVariable[]) {
  return `_aira_execute(${JSON.stringify(language)}, ${JSON.stringify(code)}, ${JSON.stringify(JSON.stringify(sharing))})\n`;
}
function magic(code: string): { code: string; sharing: SharedVariable[] } {
  const end = code.indexOf("\n"), first = end === -1 ? code : code.slice(0, end);
  const tokens = first.trim().split(/\s+/), sharing: SharedVariable[] = [];
  if (tokens[0] !== "%%R" || (tokens.length - 1) % 2) invalid("INVALID_R_MAGIC");
  for (let index = 1; index < tokens.length; index += 2) {
    const option = tokens[index];
    if (!["-i", "--input", "-o", "--output"].includes(option)) invalid("INVALID_R_MAGIC");
    for (const name of tokens[index + 1].split(","))
      sharing.push({ name, direction: option === "-i" || option === "--input" ? "python-to-r" : "r-to-python" });
  }
  return { code: end === -1 ? "" : code.slice(end + 1), sharing: selected(sharing) };
}
function origin(count: number | null): z.infer<typeof importedOrigin> {
  return { kind: "imported", executed: false, native_run_id: null, external_execution_count: count };
}
function mime(cells: Wire["cells"]) {
  function check(bundle: Record<string, unknown>) {
    for (const [type, value] of Object.entries(bundle)) {
      if (!/^[^\s/]+\/[^\s]+$/.test(type)) invalid("INVALID_MIME_BUNDLE");
      if (/^application\/(?:[^/]+\+)?json$/.test(type)) continue;
      if (typeof value !== "string" && !(Array.isArray(value) && value.every(part => typeof part === "string"))) invalid("INVALID_MIME_BUNDLE");
    }
  }
  for (const cell of cells)
    if (cell.cell_type === "code") {
      for (const output of cell.outputs) if ("data" in output) check(output.data);
    } else for (const attachment of Object.values(cell.attachments ?? {})) check(attachment);
}
/** @id CODE-XCH-EXCHANGE @implements REQ-XCH-001 REQ-XCH-002 */
export class Exchange {
  private assets: Promise<{ bootstrap: string; hash: string }> | undefined;
  constructor(private readonly notebooks: Notebooks) {}
  private load() {
    return this.assets ??= Promise.all([
      readFile(join(process.cwd(), "runtime/typed_bridge.py"), "utf8"),
      readFile(join(process.cwd(), "runtime/notebook_exchange.py"), "utf8"),
    ]).then(([bridge, template]) => {
      if (template.split("__AIRA_BRIDGE_SOURCE__").length !== 2) throw new ServiceError(503, "INVALID_EXCHANGE_BOOTSTRAP");
      return { bootstrap: template.replace("__AIRA_BRIDGE_SOURCE__", () => JSON.stringify(bridge)), hash: createHash("sha256").update(bridge).digest("hex") };
    });
  }
  async decode(raw: Uint8Array): Promise<NotebookDocument> {
    if (raw.byteLength > BODY_LIMIT) throw new ServiceError(413, "EXCHANGE_BODY_TOO_LARGE");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch (error) { if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) invalid("INVALID_EXCHANGE_JSON"); throw error; }
    const document = parse(documentSchema, value);
    const rawDocument = parse(z.object({ cells: z.array(z.object({ cell_type: z.string(), outputs: z.unknown().optional(), attachments: z.unknown().optional() })) }), value);
    displayBudget(rawDocument.cells);
    const language = defaultLanguage(document.metadata);
    displayBudget(document.cells); mime(document.cells);
    const assets = await this.load(), seen = new Set<string>();
    const cells: NotebookDocument["cells"] = [], generated: History["generated"] = [];
    for (const cell of document.cells) {
      const id = cell.id ?? randomUUID();
      if (seen.has(id)) invalid("DUPLICATE_CELL_ID");
      seen.add(id);
      if (cell.cell_type === "code" && cell.metadata.aira && typeof cell.metadata.aira === "object" && !Array.isArray(cell.metadata.aira) && "bootstrap" in cell.metadata.aira) {
        const declaration = parse(bootstrapDescriptor, cell.metadata.aira);
        if (declaration.bridge_sha256 !== assets.hash || cell.source !== assets.bootstrap || generated.length) invalid("MODIFIED_EXCHANGE_BOOTSTRAP");
        generated.push({ id, source: cell.source, metadata: cell.metadata, outputs: cell.outputs, origin: origin(cell.execution_count) });
        continue;
      }
      if (cells.length >= 100) throw new ServiceError(413, "EXCHANGE_CELL_LIMIT");
      if (cell.cell_type !== "code") {
        sourceBudget(cell.source); cells.push({ ...cell, id }); continue;
      }
      let code = cell.source;
      let configuration: z.infer<typeof settings>;
      const declaration = cell.metadata.aira ?? {};
      if (declaration && typeof declaration === "object" && !Array.isArray(declaration) && "wrapper" in declaration) {
        const known = parse(descriptor, declaration);
        selected(known.sharing);
        if (code !== wrapper(known.language, known.source, known.sharing)) invalid("MODIFIED_EXCHANGE_WRAPPER");
        code = known.source; configuration = { language: known.language, sharing: known.sharing };
      } else {
        const provided = parse(settings.partial(), declaration);
        configuration = { language: provided.language ?? language, sharing: selected(provided.sharing ?? []) };
        if (code.startsWith("%%R")) { const converted = magic(code); code = converted.code; configuration = { language: "r", sharing: converted.sharing }; }
      }
      sourceBudget(code);
      cells.push({ ...cell, id, source: code, execution_count: null, metadata: { ...cell.metadata, aira: configuration, aira_imported: origin(cell.execution_count) } });
    }
    const history: History = { version: 1, document_metadata: document.metadata, generated };
    const metadata = { ...document.metadata };
    delete metadata.aira; delete metadata.aira_exchange;
    return {
      nbformat: 4, nbformat_minor: 5, cells,
      metadata: { ...metadata, kernelspec: { name: "python3", display_name: "Python 3 (ipykernel)", language: "python" }, language_info: { name: "python" }, aira_exchange: history },
    };
  }
  async encode(input: NotebookDocument): Promise<Buffer> {
    const document = parse(documentSchema, input);
    if (document.cells.length > 100) throw new ServiceError(413, "EXCHANGE_CELL_LIMIT");
    const assets = await this.load();
    const history = document.metadata.aira_exchange === undefined ? undefined : parse(historySchema, document.metadata.aira_exchange);
    const initial = history?.generated[0];
    if (initial && (initial.source !== assets.bootstrap || parse(bootstrapDescriptor, initial.metadata.aira).bridge_sha256 !== assets.hash)) invalid("MODIFIED_EXCHANGE_BOOTSTRAP");
    const initialId = initial?.id ?? `aira-init-${assets.hash.slice(0, 40)}`;
    const seen = new Set([initialId]);
    const cells: Wire["cells"] = [{
      id: initialId, cell_type: "code", source: assets.bootstrap, metadata: initial?.metadata ?? { aira: { bootstrap: 1, bridge_sha256: assets.hash } },
      outputs: initial?.outputs ?? [], execution_count: initial?.origin.external_execution_count ?? null,
    }];
    for (const cell of document.cells) {
      const id = cell.id ?? randomUUID(); if (seen.has(id)) invalid("DUPLICATE_CELL_ID"); seen.add(id);
      sourceBudget(cell.source);
      if (cell.cell_type !== "code") { cells.push({ ...cell, id }); continue; }
      const configuration = parse(settings, cell.metadata.aira);
      selected(configuration.sharing);
      const prior = cell.metadata.aira_imported === undefined ? undefined : parse(importedOrigin, cell.metadata.aira_imported);
      cells.push({ ...cell, id, source: wrapper(configuration.language, cell.source, configuration.sharing), execution_count: cell.execution_count ?? prior?.external_execution_count ?? null, metadata: { ...cell.metadata, aira: { ...configuration, wrapper: 1, source: cell.source } } });
    }
    displayBudget(cells); mime(cells);
    const metadata = { ...(history?.document_metadata ?? document.metadata) };
    delete metadata.aira; delete metadata.aira_exchange;
    const exported: Wire = { nbformat: 4, nbformat_minor: 5, cells, metadata: { ...metadata, kernelspec: { name: "python3", language: "python", display_name: "Python 3 (ipykernel)" }, language_info: { name: "python" }, aira: { export_version: 1, bridge_sha256: assets.hash } } };
    const encoded = Buffer.from(JSON.stringify(exported));
    if (encoded.length > BODY_LIMIT) throw new ServiceError(413, "EXCHANGE_BODY_TOO_LARGE");
    return encoded;
  }
  async import(actor: string, projectId: string, name: string, raw: Uint8Array) {
    return this.notebooks.createImported(actor, projectId, name, await this.decode(raw), raw);
  }
  async export(actor: string, projectId: string, id: string) {
    return this.encode((await this.notebooks.get(actor, projectId, id)).document);
  }
}

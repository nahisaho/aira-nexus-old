import { createHash } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "./http";

export const MAX_HISTORY_CHARACTERS = 32000;
export const MAX_PROMPT_CHARACTERS = 16000;
export const MAX_EXCERPT_BYTES = 32 * 1024;
export const MAX_EXCERPTS = 32;

export interface HistoryTurn {
  id: string;
  prompt: string;
  response: string;
}
export interface ChatHistory {
  turns: HistoryTurn[];
  omittedComplete: number;
  omittedIncomplete: number;
}
export interface ExcerptSelection {
  kind: "file" | "result";
  sourceId: string;
  start: number;
  end: number;
}
export interface OwnedExcerpt extends ExcerptSelection {
  actor: string;
  projectId: string;
  text: string;
}
export type ExcerptResolver = (
  selection: ExcerptSelection,
  scope: Readonly<{ actor: string; projectId: string }>,
) => Promise<OwnedExcerpt>;
export interface TurnContext {
  wire: string;
  fingerprint: string;
  history: ChatHistory;
  excerpts: (ExcerptSelection & { text: string })[];
}

export function validText(value: string, maximum: number, trim = false) {
  const text = trim ? value.trim() : value;
  if (
    !text.length ||
    text.length > maximum * 2 ||
    [...text].length > maximum ||
    text.includes("\0")
  ) {
    throw new ServiceError(400, "INVALID_TEXT");
  }
  if (Buffer.from(text, "utf8").toString("utf8") !== text)
    throw new ServiceError(400, "INVALID_TEXT");
  return text;
}

/** @id CODE-PROV-JSON @implements REQ-PROV-001 REQ-PROV-002 */
export function encodedJson(
  value: unknown,
  maximum: number,
  invalidCode: string,
  tooLargeCode: string,
) {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (key, entry: unknown) => {
      for (const text of [key, ...(typeof entry === "string" ? [entry] : [])]) {
        if (
          text.includes("\0") ||
          Buffer.from(text, "utf8").toString("utf8") !== text
        )
          throw new ServiceError(400, invalidCode);
      }
      return entry;
    });
  } catch (error) {
    if (error instanceof RangeError) throw new ServiceError(400, invalidCode);
    throw error;
  }
  if (encoded === undefined) throw new ServiceError(400, invalidCode);
  if (Buffer.byteLength(encoded) > maximum)
    throw new ServiceError(413, tooLargeCode);
  return encoded;
}

export const selectionSchema = z
  .object({
    kind: z.enum(["file", "result"]),
    sourceId: z.uuid(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.end > value.start);

/** @id CODE-SESSION-CONTEXT @implements REQ-SESSION-003 REQ-CITE-003 */
export async function buildContext(
  actor: string,
  projectId: string,
  chatId: string,
  prompt: string,
  history: ChatHistory,
  selections: ExcerptSelection[],
  resolver?: ExcerptResolver,
): Promise<TurnContext> {
  validText(prompt, MAX_PROMPT_CHARACTERS);
  if (!Array.isArray(selections) || selections.length > MAX_EXCERPTS) {
    throw new ServiceError(400, "INVALID_EXCERPT_SELECTION");
  }
  const excerpts: TurnContext["excerpts"] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const input of selections) {
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success)
      throw new ServiceError(400, "INVALID_EXCERPT_SELECTION");
    const selection = parsed.data;
    const key = JSON.stringify(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!resolver) throw new ServiceError(503, "EXCERPT_RESOLVER_UNAVAILABLE");
    // The resolver is a server-side ownership capability, never client-supplied authority.
    const resolved = await resolver(selection, { actor, projectId });
    if (
      resolved.actor !== actor ||
      resolved.projectId !== projectId ||
      resolved.sourceId !== selection.sourceId ||
      resolved.kind !== selection.kind ||
      resolved.start !== selection.start ||
      resolved.end !== selection.end
    ) {
      throw new ServiceError(404, "EXCERPT_NOT_FOUND");
    }
    if (
      typeof resolved.text !== "string" ||
      Buffer.from(resolved.text, "utf8").toString("utf8") !== resolved.text
    ) {
      throw new ServiceError(400, "INVALID_EXCERPT_TEXT");
    }
    bytes += Buffer.byteLength(resolved.text, "utf8");
    if (bytes > MAX_EXCERPT_BYTES)
      throw new ServiceError(413, "EXCERPT_BUDGET_EXCEEDED");
    excerpts.push({ ...selection, text: resolved.text });
  }
  const wire = JSON.stringify({
    projectId,
    chatId,
    prompt,
    history: history.turns,
    excerpts,
    omissions: {
      complete: history.omittedComplete,
      incomplete: history.omittedIncomplete,
    },
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ actor, wire }))
    .digest("hex");
  return { wire, fingerprint, history, excerpts };
}

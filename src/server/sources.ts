import type { Files } from "./files";
import type { Provenance, ArtifactRecord } from "./provenance";
import type { Confirmations } from "./confirmations";
import type { CapturedRun } from "./run-snapshots";
import type { ExcerptResolver } from "./chat-context";
import { createHash } from "node:crypto";
import { projectId as validId } from "./project-scope";
import { ServiceError } from "./http";
export type SourceRecord =
  | { kind: "file"; token: string; version: ArtifactRecord }
  | {
      kind: "run";
      token: string;
      sourceSha256: string;
      snapshot: CapturedRun;
    };
/** @id CODE-CITE-SOURCES @implements REQ-CITE-001 REQ-CITE-002 REQ-CITE-003 */
export class Sources {
  constructor(
    private readonly files: Files,
    private readonly provenance: Provenance,
    private readonly confirmations: Confirmations,
  ) {}
  async resolve(
    actor: string,
    projectId: string,
    kind: string,
    id: string,
  ): Promise<SourceRecord> {
    if (kind !== "file" && kind !== "run")
      throw new ServiceError(400, "INVALID_SOURCE_REFERENCE");
    validId(id);
    const sourceId = id.toLowerCase();
    if (kind === "file") {
      await this.files.get(actor, projectId, sourceId);
      const version = await this.provenance.artifact(
        actor,
        projectId,
        sourceId,
      );
      return { kind, token: `[file:${version.id}]`, version };
    }
    const snapshot = await this.provenance.get(actor, projectId, sourceId);
    return {
      kind,
      token: `[run:${snapshot.id}]`,
      sourceSha256: createHash("sha256").update(snapshot.source).digest("hex"),
      snapshot,
    };
  }
  readonly resolver: ExcerptResolver = async (selection, scope) => {
    const snapshot = await this.confirmations.readDisclosure(
      scope.actor,
      scope.projectId,
      {
        selections: [
          {
            kind: selection.kind === "result" ? "run" : "file",
            id: selection.sourceId,
            start: selection.start,
            end: selection.end,
          },
        ],
      },
    );
    return { ...selection, ...scope, text: snapshot.text };
  };
}

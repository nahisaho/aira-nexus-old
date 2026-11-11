export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function unavailable() {
  return Response.json(
    { code: "FEATURE_NOT_IMPLEMENTED", ready: false },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

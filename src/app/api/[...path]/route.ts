import { getApplication } from "../../../server/application";
import { localResponse } from "../../../server/local-boundary";
import { ServiceError } from "../../../server/http";

export const runtime = "nodejs";
async function handle(request: Request) {
  try {
    return await (await getApplication()).handle(request);
  } catch (error) {
    console.error("APPLICATION_UNAVAILABLE");
    return localResponse(
      {
        code:
          error instanceof ServiceError
            ? error.code
            : "APPLICATION_UNAVAILABLE",
      },
      503,
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

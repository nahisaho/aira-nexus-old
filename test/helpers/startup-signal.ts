import next from "next";
const probe = next({ dev: true, hostname: "127.0.0.1" });
const prototype = Object.getPrototypeOf(probe);
prototype.prepare = async function () {
  process.send?.({ kind: "prepare-blocked" });
  await new Promise<void>((done) => process.once("message", () => done()));
};
const originalHandler = prototype.getRequestHandler;
prototype.getRequestHandler = function (...args: unknown[]) {
  process.send?.({ kind: "handler-after-stop" });
  return originalHandler.apply(this, args);
};
process.prependOnceListener("SIGTERM", () =>
  process.send?.({ kind: "signal-observed" }),
);
await import("../../scripts/start");

export interface PublicOrigin {
  origin: string;
  host: string;
  address: string;
  port: number;
}

/** @id CODE-LAN-ORIGIN @implements REQ-LAN-002 */
export function publicOrigin(
  value = process.env.AIRA_PUBLIC_ORIGIN,
  assigned?: readonly string[],
): PublicOrigin | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new ServiceError(503, "INVALID_PUBLIC_ORIGIN");
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) throw invalid();
    throw error;
  }
  const address = url.hostname;
  const octets = address.split(".").map(Number);
  const privateAddress =
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  const port = Number(url.port);
  if (
    value !== url.origin ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    isIP(address) !== 4 ||
    !privateAddress ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw invalid();
  const addresses =
    assigned ??
    Object.values(networkInterfaces())
      .flatMap((values) => values ?? [])
      .filter((info) => info.family === "IPv4" && !info.internal)
      .map((info) => info.address);
  if (!addresses.includes(address)) throw invalid();
  return { origin: url.origin, host: url.host, address, port };
}
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { ServiceError } from "./http";

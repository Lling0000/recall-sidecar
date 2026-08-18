import { createConnection } from "node:net";
import type { SidecarRequest, SidecarResponse } from "../types.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

export async function callSidecar(
  socketPath: string,
  request: SidecarRequest,
  timeoutMs: number,
): Promise<SidecarResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let response = "";
    const finish = (error: Error | null, value?: SidecarResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("empty_sidecar_response"));
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(new Error("sidecar_timeout")));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        finish(new Error("sidecar_response_too_large"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(response.slice(0, newline)) as SidecarResponse);
      } catch {
        finish(new Error("invalid_sidecar_response"));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("empty_sidecar_response")));
  });
}

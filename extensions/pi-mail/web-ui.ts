import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";

import type { MailService } from "./mail-service.ts";

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const UI_HOST = "127.0.0.1";

interface WebUiHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

interface ComposeRequest {
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  body?: unknown;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function requestToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function composeInput(value: unknown): { to: string[]; cc: string[]; subject?: string; body: string } {
  const input = (typeof value === "object" && value !== null ? value : {}) as ComposeRequest;
  const body = typeof input.body === "string" ? input.body : "";
  if (!body.trim()) throw new Error("Message body is required");

  return {
    to: stringArray(input.to),
    cc: stringArray(input.cc),
    subject: typeof input.subject === "string" ? input.subject : undefined,
    body,
  };
}

async function renderHtml(): Promise<{ html: string; nonce: string }> {
  const templateUrl = new URL("./web/index.html", import.meta.url);
  const template = await readFile(templateUrl, "utf8");
  const nonce = randomBytes(18).toString("base64url");
  return { html: template.replaceAll("__CSP_NONCE__", nonce), nonce };
}

export async function startWebUi(service: MailService): Promise<WebUiHandle> {
  const token = randomBytes(24).toString("base64url");
  let server: Server;
  let closing = false;

  const close = (): Promise<void> => new Promise((resolve) => {
    if (closing || !server.listening) {
      resolve();
      return;
    }
    closing = true;
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${UI_HOST}`);

      if (url.pathname === "/" && request.method === "GET") {
        const { html, nonce } = await renderHtml();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            "connect-src 'self'",
            "img-src 'self' data:",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join("; "),
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        });
        response.end(html);
        return;
      }

      if (url.pathname === "/favicon.ico") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "Not found" });
        return;
      }

      // The UI can inject genuine human messages into active Pi sessions.
      // Loopback binding is not sufficient protection against browser-based
      // cross-origin requests, so every mutating/read API call also requires
      // an unguessable token carried in the Authorization header.
      if (requestToken(request) !== token) {
        json(response, 401, { error: "Unauthorized" });
        return;
      }

      if (url.pathname === "/api/state" && request.method === "GET") {
        json(response, 200, {
          status: await service.status(),
          peers: await service.discover({ includeInactive: true }),
          messages: await service.listProjectMessages({ limit: 100 }),
        });
        return;
      }

      if (url.pathname === "/api/send" && request.method === "POST") {
        const message = await service.sendAsHuman(composeInput(await readJsonBody(request)));
        json(response, 201, { message });
        return;
      }

      if (url.pathname === "/api/close" && request.method === "POST") {
        json(response, 200, { closing: true });
        setTimeout(() => void close(), 25).unref();
        return;
      }

      json(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(response, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, UI_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Pi Mail Web UI failed to acquire a local TCP port");
  }

  return {
    port: address.port,
    url: `http://${UI_HOST}:${address.port}/?token=${encodeURIComponent(token)}`,
    close,
  };
}

export function openWebUiInBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };

  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a browser is convenience only. The command handler always shows
    // the URL so headless environments remain fully usable.
  }
}

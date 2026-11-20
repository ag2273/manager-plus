import { randomBytes } from "node:crypto";
import { type Server, type TLSSocket, createServer } from "node:tls";
import type { Business } from "../core/business";
import { BusinessError } from "../core/errors";
import { BUSINESS_METHODS, type BusinessMethod } from "../shared/api";
import type { ServerIdentity } from "./certificate";
import type { Hello, Reply, Request, SignedIn } from "./protocol";

/** Longest request line accepted; anything longer is a broken or hostile client. */
const MAX_LINE = 4 * 1024 * 1024;

export type RunningServer = { port: number; fingerprint: string; clients: () => number; close: () => Promise<void> };

function answer(id: number, work: () => unknown): Reply {
  try {
    return { id, ok: true, value: work() ?? null };
  } catch (error) {
    if (error instanceof BusinessError) return { id, ok: false, code: error.code, message: error.message };
    console.error(error);
    return { id, ok: false, code: "unexpected", message: String(error) };
  }
}

/**
 * Serves the open business to other PCs over TLS. `file` is the business signed
 * out; each sign-in gets its own `Business` acting for that user on the same
 * database, so every command still checks the role and is audited. Requests are
 * answered one at a time in arrival order, which keeps SQLite to one writer.
 */
export function startServer(file: Business, identity: ServerIdentity, options: { port: number; host?: string }): Promise<RunningServer> {
  const sessions = new Map<string, Business>();
  const sockets = new Set<TLSSocket>();

  function handle(request: Request, connection: { token: string | null }): Reply {
    const id = typeof request.id === "number" ? request.id : 0;
    return answer(id, () => {
      switch (request.op) {
        case "hello":
          return { app: "manager-plus", protocol: 1, settings: file.settings() } satisfies Hello;
        case "signIn": {
          const business = file.signIn(String(request.name), String(request.password));
          const token = randomBytes(32).toString("base64url");
          sessions.set(token, business);
          connection.token = token;
          return { user: business.currentUser()!, token } satisfies SignedIn;
        }
        case "resume": {
          const business = sessions.get(String(request.token));
          if (!business) throw new BusinessError("sign_in_required", "That session has ended; sign in again");
          connection.token = String(request.token);
          return business.currentUser();
        }
        case "signOut":
          if (connection.token) sessions.delete(connection.token);
          connection.token = null;
          return null;
        case "call": {
          const method = request.method as BusinessMethod;
          if (!BUSINESS_METHODS.includes(method) || !Array.isArray(request.args)) {
            throw new BusinessError("not_allowed", `Not a business method: ${String(request.method)}`);
          }
          const business = connection.token ? sessions.get(connection.token) : undefined;
          if (!business) throw new BusinessError("sign_in_required", "Sign in first");
          return (business[method] as (...a: unknown[]) => unknown).apply(business, request.args);
        }
        default:
          throw new BusinessError("not_allowed", "Unknown request");
      }
    });
  }

  const server: Server = createServer({ key: identity.key, cert: identity.cert, minVersion: "TLSv1.2" }, (socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    const connection = { token: null as string | null };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        let reply: Reply;
        try {
          reply = handle(JSON.parse(line) as Request, connection);
        } catch {
          reply = { id: 0, ok: false, code: "unexpected", message: "Bad request" };
        }
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : options.port,
        fingerprint: identity.fingerprint,
        clients: () => sockets.size,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            sessions.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

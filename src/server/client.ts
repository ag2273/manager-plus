import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { Credentials, Result, User } from "../shared/api";
import type { Hello, Reply, Request, SignedIn } from "./protocol";

/** Raised by `connect` when the server cannot be reached or is not who it was. */
export class ConnectError extends Error {
  constructor(
    readonly code: "server_unreachable" | "server_identity_changed" | "not_a_server",
    message: string,
  ) {
    super(message);
  }
}

const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

type Pending = { resolve: (reply: Reply) => void; timer: NodeJS.Timeout };
type Body = Request extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

/** One TLS connection; it fails every waiting request when it drops. */
class Link {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  closed = false;

  constructor(private readonly socket: TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const reply = JSON.parse(line) as Reply;
        const waiting = this.pending.get(reply.id);
        if (!waiting) continue;
        clearTimeout(waiting.timer);
        this.pending.delete(reply.id);
        waiting.resolve(reply);
      }
    });
    const drop = () => {
      this.closed = true;
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer);
        waiting.resolve({ id, ok: false, code: "server_unreachable", message: "The connection to the server was lost" });
      }
      this.pending.clear();
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  send(body: Body): Promise<Reply> {
    const id = this.next++;
    return new Promise((resolve) => {
      if (this.closed) {
        resolve({ id, ok: false, code: "server_unreachable", message: "Not connected to the server" });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, code: "server_unreachable", message: "The server did not answer" });
        this.socket.destroy();
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.socket.write(`${JSON.stringify({ ...body, id })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

/** Opens TLS to the server and checks its certificate against the pinned fingerprint, if there is one. */
function open(host: string, port: number, pinned: string | null): Promise<{ link: Link; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    // The certificate is self-signed, so the chain is not checked; the pinned fingerprint is.
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, minVersion: "TLSv1.2", timeout: CONNECT_TIMEOUT_MS });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error instanceof ConnectError ? error : new ConnectError("server_unreachable", `Cannot reach ${host}:${port}: ${error.message}`));
    };
    socket.once("timeout", () => fail(new Error("timed out")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.setTimeout(0);
      socket.off("error", fail);
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      if (pinned && fingerprint !== pinned) {
        fail(new ConnectError("server_identity_changed", `The server at ${host}:${port} presented a different certificate`));
        return;
      }
      resolve({ link: new Link(socket), fingerprint });
    });
  });
}

function toResult<T>(reply: Reply): Result<T> {
  if (reply.ok) return { ok: true, value: reply.value as T };
  const { code, message, amount } = reply;
  return { ok: false, code, message, ...(amount === undefined ? {} : { amount }) };
}

/**
 * A business served by another PC. Calls return the same `Result` as the local
 * channel. When the connection drops, the next call reconnects and resumes the
 * session; while the server is off, calls fail with `server_unreachable`.
 */
export class RemoteBusiness {
  private token: string | null = null;

  private constructor(
    readonly host: string,
    readonly port: number,
    readonly fingerprint: string,
    readonly hello: Hello,
    private link: Link,
  ) {}

  /** Connects, checking the pinned fingerprint when given (trust on first use otherwise). */
  static async connect(host: string, port: number, pinned: string | null = null): Promise<RemoteBusiness> {
    const { link, fingerprint } = await open(host, port, pinned);
    const reply = await link.send({ op: "hello" });
    const hello = reply.ok ? (reply.value as Hello) : null;
    if (!hello || hello.app !== "manager-plus") {
      link.close();
      throw new ConnectError("not_a_server", `${host}:${port} is not a Manager+ server`);
    }
    return new RemoteBusiness(host, port, fingerprint, hello, link);
  }

  /** Sends a request, reconnecting (to the same certificate) and resuming the session first if the link dropped. */
  private async send(body: Body): Promise<Reply> {
    if (this.link.closed) {
      try {
        this.link = (await open(this.host, this.port, this.fingerprint)).link;
      } catch (error) {
        const code = error instanceof ConnectError ? error.code : "server_unreachable";
        return { id: 0, ok: false, code, message: String(error) };
      }
      if (this.token) {
        const resumed = await this.link.send({ op: "resume", token: this.token });
        if (!resumed.ok) {
          this.token = null;
          return resumed;
        }
      }
    }
    return this.link.send(body);
  }

  async signIn(credentials: Credentials): Promise<Result<User>> {
    const reply = await this.send({ op: "signIn", name: credentials.name, password: credentials.password });
    if (!reply.ok) return toResult(reply);
    const signed = reply.value as SignedIn;
    this.token = signed.token;
    return { ok: true, value: signed.user };
  }

  async signOut(): Promise<void> {
    await this.send({ op: "signOut" });
    this.token = null;
  }

  call<T = unknown>(method: string, args: unknown[]): Promise<Result<T>> {
    return this.send({ op: "call", method, args }).then((r) => toResult<T>(r));
  }

  close(): void {
    this.link.close();
  }
}

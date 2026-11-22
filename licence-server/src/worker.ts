import { adminPage } from "./admin-page";
import {
  type D1Like,
  Refused,
  activate,
  createLicence,
  listLicences,
  recordPayment,
  replaceKey,
  resetActivations,
  revokeLicence,
  sha256,
  signer,
  updateLicence,
  withinLimit,
} from "./licences";

export type Env = {
  DB: D1Like;
  /** The Ed25519 private key (PKCS#8, base64 or PEM), set with `wrangler secret put LICENCE_PRIVATE_KEY`. */
  LICENCE_PRIVATE_KEY: string;
  /** The admin page's password, set with `wrangler secret put ADMIN_PASSWORD`. */
  ADMIN_PASSWORD: string;
};

const HOUR = 60 * 60 * 1000;
/** Activations allowed per IP address per hour, and wrong admin passwords. */
const ACTIVATIONS_PER_HOUR = 10;
const ADMIN_FAILURES_PER_HOUR = 10;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

/** Compares two secrets in time that doesn't depend on where they differ. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ") || !env.ADMIN_PASSWORD) return false;
  let password: string;
  try {
    password = atob(header.slice(6)).split(":").slice(1).join(":");
  } catch {
    return false;
  }
  return sameSecret(password, env.ADMIN_PASSWORD);
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Refused("invalid_input");
  }
}

/** The licence server: `/v1/activate` for the app, `/admin` for the owner. */
export async function handle(request: Request, env: Env, now = new Date()): Promise<Response> {
  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  try {
    if (url.pathname === "/v1/activate" && request.method === "POST") {
      if (!(await withinLimit(env.DB, `activate:${ip}`, ACTIVATIONS_PER_HOUR, HOUR, now))) return json({ error: "licence_rate_limited" }, 429);
      const input = await body<{ key?: unknown; machine?: unknown; appVersion?: unknown }>(request);
      if (typeof input.key !== "string" || typeof input.machine !== "string") throw new Refused("invalid_input");
      const file = await activate(
        env.DB,
        await signer(env.LICENCE_PRIVATE_KEY),
        { key: input.key, machine: input.machine, appVersion: String(input.appVersion ?? "") },
        now,
      );
      return json({ licence: file });
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!(await isAdmin(request, env))) {
        if (!(await withinLimit(env.DB, `admin:${ip}`, ADMIN_FAILURES_PER_HOUR, HOUR, now))) return json({ error: "rate_limited" }, 429);
        return new Response("Sign in", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Manager+ licences", charset="UTF-8"' } });
      }
      if (url.pathname === "/admin" && request.method === "GET") {
        return new Response(adminPage, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
            "X-Frame-Options": "DENY",
          },
        });
      }
      return await adminApi(url.pathname.slice("/admin/api".length), request, env, now);
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof Refused) {
      const status =
        error.code === "invalid_input"
          ? 400
          : error.code === "not_found"
            ? 404
            : error.code === "licence_moves_exhausted"
              ? 409
              : error.code === "licence_revoked"
                ? 403
                : 404;
      return json({ error: error.code }, status);
    }
    console.error(error);
    return json({ error: "server_error" }, 500);
  }
}

async function adminApi(path: string, request: Request, env: Env, now: Date): Promise<Response> {
  if (path === "/licences" && request.method === "GET") return json(await listLicences(env.DB, now));
  if (path === "/licences" && request.method === "POST") {
    const input = await body<{ company: string; users: number; supportUntil: string; notes?: string }>(request);
    return json(await createLicence(env.DB, input, now), 201);
  }
  const match = /^\/licences\/(\d+)\/(payments|update|reset|revoke|new-key)$/.exec(path);
  if (!match || request.method !== "POST") return json({ error: "not_found" }, 404);
  const id = Number(match[1]);
  switch (match[2]) {
    case "payments":
      await recordPayment(env.DB, id, await body(request), now);
      return json({ ok: true });
    case "update":
      await updateLicence(env.DB, id, await body(request));
      return json({ ok: true });
    case "reset":
      await resetActivations(env.DB, id, now);
      return json({ ok: true });
    case "revoke":
      await revokeLicence(env.DB, id, now);
      return json({ ok: true });
    default:
      return json({ key: await replaceKey(env.DB, id) });
  }
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };

import type { BusinessSettings, User } from "../shared/api";

/** The port a server listens on unless told otherwise. */
export const DEFAULT_PORT = 47_100;
/** The mDNS service servers announce and clients look for. */
export const SERVICE = "_managerplus._tcp.local";

/** One line from client to server. */
export type Request =
  | { id: number; op: "hello" }
  | { id: number; op: "signIn"; name: string; password: string }
  | { id: number; op: "resume"; token: string }
  | { id: number; op: "signOut" }
  | { id: number; op: "call"; method: string; args: unknown[] };

/** What `hello` answers, before anyone signs in. */
export type Hello = { app: "manager-plus"; protocol: 1; settings: BusinessSettings };
export type SignedIn = { user: User; token: string };

/** One line from server to client, answering the request with the same id. */
export type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; code: string; message: string };

import { hostname, networkInterfaces } from "node:os";
import makeMdns from "multicast-dns";
import { SERVICE } from "./protocol";

/** A server heard on the network. */
export type FoundServer = { name: string; host: string; port: number };

/** This PC's IPv4 addresses on the local network. */
function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/** Answers mDNS questions for the Manager+ service with this PC's address, port and business name. Returns a stop function. */
export function advertise(businessName: string, port: number): () => void {
  const mdns = makeMdns();
  const host = `${hostname().replace(/[^A-Za-z0-9-]/g, "-") || "manager-plus"}.local`;
  const instance = `${host.replace(/\.local$/, "")}.${SERVICE}`;
  mdns.on("query", (query) => {
    if (!(query.questions ?? []).some((q) => q.name === SERVICE || q.name === instance)) return;
    mdns.respond({
      answers: [{ name: SERVICE, type: "PTR", ttl: 120, data: instance }],
      additionals: [
        { name: instance, type: "SRV", ttl: 120, data: { port, target: host, priority: 0, weight: 0 } },
        { name: instance, type: "TXT", ttl: 120, data: [Buffer.from(`name=${businessName}`, "utf8")] },
        ...localAddresses().map((ip) => ({ name: host, type: "A" as const, ttl: 120, data: ip })),
      ],
    });
  });
  return () => mdns.destroy();
}

/** Asks the network for Manager+ servers and collects the answers for `waitMs`. */
export function discover(waitMs = 1_500): Promise<FoundServer[]> {
  return new Promise((resolve) => {
    const mdns = makeMdns();
    const found = new Map<string, FoundServer>();
    mdns.on("response", (response) => {
      const records = [...(response.answers ?? []), ...(response.additionals ?? [])];
      for (const ptr of records) {
        if (ptr.type !== "PTR" || ptr.name !== SERVICE) continue;
        const instance = String(ptr.data);
        const srv = records.find((r) => r.type === "SRV" && r.name === instance);
        const txt = records.find((r) => r.type === "TXT" && r.name === instance);
        if (!srv || srv.type !== "SRV") continue;
        const a = records.find((r) => r.type === "A" && r.name === srv.data.target);
        const text = txt && txt.type === "TXT" ? [txt.data].flat().map((d) => d.toString()).find((t) => t.startsWith("name=")) : undefined;
        const host = a && a.type === "A" ? String(a.data) : srv.data.target;
        found.set(`${host}:${srv.data.port}`, { name: text?.slice(5) ?? instance, host, port: srv.data.port });
      }
    });
    mdns.query({ questions: [{ name: SERVICE, type: "PTR" }] });
    setTimeout(() => {
      mdns.destroy();
      resolve([...found.values()]);
    }, waitMs);
  });
}

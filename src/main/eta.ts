import { execFile } from "node:child_process";
import type { EtaCredentials } from "../core/eta/store";
import type { Signer } from "../core/eta/cades";
import type { EtaReceiptCredentials } from "../core/eta/receipts-store";
import type { EtaClient, EtaReceiptClient, EtaVerdict } from "../core/eta/sender";
import type { TokenCertificate } from "../shared/api";

/** The ETA's identity server and invoicing API, per environment. */
const HOSTS = {
  preprod: { id: "https://id.preprod.eta.gov.eg", api: "https://api.preprod.invoicing.eta.gov.eg" },
  production: { id: "https://id.eta.gov.eg", api: "https://api.invoicing.eta.gov.eg" },
};

type EtaError = { message?: string; details?: { message?: string; target?: string }[] };
const errorText = (e: EtaError | undefined) =>
  [e?.message, ...(e?.details ?? []).map((d) => [d.target, d.message].filter(Boolean).join(": "))].filter(Boolean).join(" · ") || "Rejected";

/** The ETA invoicing API over HTTPS, signing in with the business's client ID and secret. */
export function httpEtaClient(credentials: EtaCredentials & { clientSecret: string }): EtaClient {
  const hosts = HOSTS[credentials.environment];
  let token: { value: string; until: number } | null = null;

  async function bearer(): Promise<string> {
    if (token && token.until > Date.now()) return token.value;
    const response = await fetch(`${hosts.id}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: "InvoicingAPI",
      }),
    });
    if (!response.ok) throw new Error(`ETA sign-in failed (${response.status})`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return token.value;
  }

  async function api(path: string, init: { method: string; body?: unknown }): Promise<Response> {
    const response = await fetch(`${hosts.api}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status >= 500) throw new Error(`ETA error ${response.status}`);
    return response;
  }

  return {
    async submit(documents) {
      const response = await api("/api/v1/documentsubmissions", { method: "POST", body: { documents } });
      const body = (await response.json()) as {
        acceptedDocuments?: { uuid: string; internalId: string }[];
        rejectedDocuments?: { internalId: string; error?: EtaError }[];
        error?: EtaError;
      };
      if (!response.ok && !body.rejectedDocuments) throw new Error(errorText(body.error));
      return {
        accepted: (body.acceptedDocuments ?? []).map((d) => ({ internalId: d.internalId, uuid: d.uuid })),
        rejected: (body.rejectedDocuments ?? []).map((d) => ({ internalId: d.internalId, error: errorText(d.error) })),
      };
    },
    async status(uuid) {
      const response = await api(`/api/v1/documents/${encodeURIComponent(uuid)}/details`, { method: "GET" });
      if (!response.ok) return { status: "submitted" };
      const body = (await response.json()) as { status?: string; validationResults?: { validationSteps?: { status?: string; error?: EtaError }[] } };
      const status = (body.status ?? "").toLowerCase();
      if (status === "valid") return { status: "valid" };
      if (status === "cancelled") return { status: "cancelled" };
      if (status === "invalid" || status === "rejected") {
        const failed = (body.validationResults?.validationSteps ?? []).filter((s) => s.status?.toLowerCase() === "invalid");
        return { status: "invalid", error: failed.map((s) => errorText(s.error)).join(" · ") || "Invalid" } satisfies EtaVerdict;
      }
      return { status: "submitted" };
    },
    async cancel(uuid, reason) {
      const response = await api(`/api/v1.0/documents/state/${encodeURIComponent(uuid)}/state`, {
        method: "PUT",
        body: { status: "cancelled", reason },
      });
      if (!response.ok) throw new Error(`The ETA refused the cancellation (${response.status})`);
    },
  };
}

/**
 * The ETA e-receipt API for the registered POS. It signs in as the POS, naming its serial, OS
 * and model and the pre-shared key the ETA gave it; receipts are not signed with the token.
 */
export function httpEtaReceiptClient(credentials: EtaReceiptCredentials): EtaReceiptClient {
  const hosts = HOSTS[credentials.production ? "production" : "preprod"];
  let token: { value: string; until: number } | null = null;

  async function bearer(): Promise<string> {
    if (token && token.until > Date.now()) return token.value;
    const response = await fetch(`${hosts.id}/connect/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        posserial: credentials.posSerial,
        pososversion: credentials.posOsVersion,
        posmodelframework: credentials.posModel,
        presharedkey: credentials.presharedKey,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.posClientId, client_secret: credentials.posClientSecret }),
    });
    if (!response.ok) throw new Error(`ETA POS sign-in failed (${response.status})`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return token.value;
  }

  async function api(path: string, init: { method: string; body?: unknown }): Promise<Response> {
    const response = await fetch(`${hosts.api}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status >= 500) throw new Error(`ETA error ${response.status}`);
    return response;
  }

  return {
    async submitReceipts(receipts) {
      const response = await api("/api/v1/receiptsubmissions", { method: "POST", body: { receipts } });
      const body = (await response.json()) as {
        acceptedDocuments?: { uuid: string }[];
        rejectedDocuments?: { uuid: string; error?: EtaError }[];
        error?: EtaError;
      };
      if (!response.ok && !body.rejectedDocuments) throw new Error(errorText(body.error));
      return {
        accepted: (body.acceptedDocuments ?? []).map((d) => ({ uuid: d.uuid })),
        rejected: (body.rejectedDocuments ?? []).map((d) => ({ uuid: d.uuid, error: errorText(d.error) })),
      };
    },
    async receiptStatus(uuid) {
      const response = await api(`/api/v1/receipts/${encodeURIComponent(uuid)}/details`, { method: "GET" });
      if (!response.ok) return { status: "submitted" };
      const body = (await response.json()) as {
        receipt?: { status?: string };
        validationResults?: { validationSteps?: { status?: string; error?: EtaError }[] };
      };
      const status = (body.receipt?.status ?? "").toLowerCase();
      if (status === "valid") return { status: "valid" };
      if (status === "invalid") {
        const failed = (body.validationResults?.validationSteps ?? []).filter((s) => s.status?.toLowerCase() === "invalid");
        return { status: "invalid", error: failed.map((s) => errorText(s.error)).join(" · ") || "Invalid" } satisfies EtaVerdict;
      }
      return { status: "submitted" };
    },
  };
}

/** Runs a PowerShell script on this Windows PC, with `input` on its standard input. */
function powershell(script: string, input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim())),
    );
    child.stdin?.end(input);
  });
}

/**
 * Signing certificates with a private key in the Windows certificate store. The USB token's
 * driver puts its certificate there while the token is plugged in.
 */
export async function listCertificates(): Promise<TokenCertificate[]> {
  if (process.platform !== "win32") return [];
  const out = await powershell(
    "@(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.HasPrivateKey } | ForEach-Object { [pscustomobject]@{ thumbprint = $_.Thumbprint; subject = $_.Subject; issuer = $_.Issuer; notAfter = $_.NotAfter.ToString('yyyy-MM-dd') } }) | ConvertTo-Json -Compress",
  );
  if (out === "") return [];
  const parsed = JSON.parse(out) as TokenCertificate | TokenCertificate[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Signs with the token's private key through Windows, which asks the token's driver; the driver
 * shows its own PIN prompt. Only the SHA-256 RSA signature is asked of the token.
 */
export function windowsTokenSigner(thumbprint: string): Signer {
  if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint)) throw new Error("The certificate thumbprint is not valid");
  const certificate = `Get-Item "Cert:\\CurrentUser\\My\\${thumbprint}"`;
  return {
    async certificate() {
      const base64 = await powershell(`[Convert]::ToBase64String((${certificate}).RawData)`);
      return new Uint8Array(Buffer.from(base64, "base64"));
    },
    async sign(data) {
      const base64 = await powershell(
        `$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());
         $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey((${certificate}));
         [Convert]::ToBase64String($key.SignData($bytes, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1))`,
        Buffer.from(data).toString("base64"),
      );
      return new Uint8Array(Buffer.from(base64, "base64"));
    },
  };
}

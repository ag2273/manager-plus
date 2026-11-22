/** One release, as our release script writes it and signs it. */
export type UpdateManifest = {
    version: string;
    /** YYYY-MM-DD: an update installs only on a licence whose support runs to this date or later. */
    releaseDate: string;
    /** The installer, over HTTPS. */
    url: string;
    sha256: string;
    size: number;
    notes: {
        ar: string;
        en: string;
    };
};
/** The manifest's JSON in base64 and its Ed25519 signature, as the update server hands it out. */
export type SignedManifest = {
    manifest: string;
    signature: string;
};
export type UpdateCheck = {
    kind: "none";
} | {
    kind: "available";
    manifest: UpdateManifest;
}
/** A newer version exists but was released after the support plan ended; the installed one keeps working. */
 | {
    kind: "not_eligible";
    manifest: UpdateManifest;
};

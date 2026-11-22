/**
 * Our release-signing Ed25519 public key; the app installs only updates whose manifest is signed
 * with its private key, which stays on the owner's PC and is never in the repo or on a server.
 *
 * Placeholder until the first release: its private key was thrown away. `node scripts/release.mjs keygen`
 * makes the real pair and writes its public key here.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASQXCAfo+WRqoXHCKA/DTmUGtS1CUa6ha7Uuio5PREIQ=
-----END PUBLIC KEY-----
`;

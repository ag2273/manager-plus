/**
 * Our release-signing Ed25519 public key; the app installs only updates whose manifest is signed
 * with its private key, which is never in the repo or on a server.
 *
 * Made on 2026-11-22 by the "Release signing key" workflow, whose private key went straight into
 * the GitHub repo secret RELEASE_PRIVATE_KEY. Making a new pair stops every installed copy from
 * accepting updates.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkcVRIII4iFJ1GO3znA2R0ETrJDg1cuFwKc/dNO03PqI=
-----END PUBLIC KEY-----
`;

/**
 * The licence server's Ed25519 public key; licence files signed with its private key are the only
 * ones this app accepts. The private key lives only as a secret on the licence server, never here.
 *
 * Made on 2026-11-22 by the "Licence signing key" workflow, whose private key went straight into
 * the Worker at licence.nileorbit.com. Making a new pair breaks every licence issued before it.
 */
export const LICENCE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAK0TsNNeLA7Kcrh/EcR/WGUVFyubRO97VXBjEd8t1cQY=
-----END PUBLIC KEY-----
`;

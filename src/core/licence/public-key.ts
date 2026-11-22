/**
 * The licence server's Ed25519 public key; licence files signed with its private key are the only
 * ones this app accepts. The private key lives only as a secret on the licence server, never here.
 *
 * Placeholder until the licence server is deployed (#21): its private key was thrown away, so no
 * licence verifies against it yet. The deploy steps generate the real pair and put its public key here.
 */
export const LICENCE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA0OKxIHVJ8xajrNCYLPIiBf75KFUBTh+2WxGEmyNSmq8=
-----END PUBLIC KEY-----
`;

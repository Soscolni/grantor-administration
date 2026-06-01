// Verify the JWT Monday signs every integration request with.
//
// Monday signs requests to an app's endpoints (action execution + remote-options
// fields) with HS256, using the app's *Signing Secret* (Developer Center ->
// your app -> Basic Information). The decoded payload carries:
//   { accountId, userId, aud, exp, iat, shortLivedToken }
// `shortLivedToken` is a ~1-minute API token scoped to the app — we use it as
// the Authorization for our GraphQL calls, so the app never needs a personal
// token.  https://developer.monday.com/apps/docs/integration-authorization
//
// Hand-rolled with node:crypto to keep this subdir dependency-light (express +
// dotenv only), consistent with the sibling automations. Only HS256 is accepted
// — rejecting any other alg closes the classic JWT alg-confusion hole.
import crypto from 'node:crypto';

function b64url(part) {
  return Buffer.from(part, 'base64url');
}

export function verifyMondayJwt(token, secret) {
  if (!token) throw new Error('missing JWT');
  if (!secret) throw new Error('MONDAY_SIGNING_SECRET is not set');

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64url(headerB64).toString('utf8'));
  if (header.alg !== 'HS256') throw new Error(`unexpected JWT alg: ${header.alg}`);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actual = b64url(sigB64);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error('bad JWT signature');
  }

  const payload = JSON.parse(b64url(payloadB64).toString('utf8'));
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('JWT expired');
  }
  return payload;
}

// Decode the JWT payload WITHOUT checking the signature. Used as a fallback when
// no signing secret is configured. Safe-ish for a private app because the real
// credential is the embedded shortLivedToken — a genuine, short-lived,
// app-scoped Monday token; a forged JWT carries no usable token. Still, set
// MONDAY_SIGNING_SECRET in production for defence-in-depth (then verifyMondayJwt
// runs instead).
export function decodeMondayJwt(token) {
  if (!token) throw new Error('missing JWT');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const payload = JSON.parse(b64url(parts[1]).toString('utf8'));
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('JWT expired');
  }
  return payload;
}

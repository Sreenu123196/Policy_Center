import type { IncomingHttpHeaders } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ApiError } from './registry.js';

// Who is asking? (document sections 13 and 17). The API does not keep passwords: an identity provider signs people
// in and gives them a signed token. The token proves WHO the person is; what they may do still comes from the roles
// in our own database. An authenticator turns the request's headers into a user name, or refuses with 401.

export interface Authenticator {
  describe: 'bearer' | 'header'; // for the OpenAPI description
  username(headers: IncomingHttpHeaders): Promise<string>; // throws ApiError 401
}

const unauthenticated = (message: string): ApiError => new ApiError(401, 'unauthenticated', message);
const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

// For local development and tests ONLY: trusts the X-User header, which anyone can forge. The server refuses to
// use it unless it is asked for by name (AUTH_MODE=header) or runs on the throw-away local database.
export const headerAuthenticator: Authenticator = {
  describe: 'header',
  async username(headers) {
    const name = headerValue(headers['x-user']);
    if (name === undefined || name.trim() === '') throw unauthenticated('Sign in: the X-User header must name an active user');
    return name;
  },
};

export interface BearerOptions {
  issuer: string; // the identity provider, exactly as it writes it in the token ("iss")
  audience: string; // this API, as the identity provider writes it ("aud")
  keys: JWTVerifyGetKey; // the identity provider's published public keys
  usernameClaim?: string; // which claim holds our user name (default preferred_username)
  clockToleranceSeconds?: number; // how far the clocks of the two servers may differ (default 30)
}

// Checks a token: the signature (only asymmetric algorithms, so nobody can sign with a shared secret or with "none"),
// the issuer, the audience and the expiry, which must be present. Every failure gives the same plain 401, so the
// answer never helps a guesser.
export function bearerAuthenticator(options: BearerOptions): Authenticator {
  const claim = options.usernameClaim ?? 'preferred_username';
  return {
    describe: 'bearer',
    async username(headers) {
      const header = headerValue(headers.authorization) ?? '';
      const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
      if (match === null) throw unauthenticated('Sign in: send the token as "Authorization: Bearer <token>"');
      try {
        const { payload } = await jwtVerify(match[1]!, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'EdDSA'],
          requiredClaims: ['exp'],
          clockTolerance: options.clockToleranceSeconds ?? 30,
        });
        const name = payload[claim];
        if (typeof name !== 'string' || name.trim() === '') throw new Error('no user name in the token');
        return name;
      } catch {
        throw unauthenticated('The token is not valid: it may be expired, or not meant for this API');
      }
    },
  };
}

// The identity provider's keys are fetched from its published key set and cached by the library.
export const remoteKeys = (jwksUrl: string): JWTVerifyGetKey => createRemoteJWKSet(new URL(jwksUrl));

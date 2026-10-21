import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuthError, verifyBearer } from '../auth.js';

const secret = 'test-signing-secret-not-a-real-credential';
const options = { secret, algorithms: ['HS256'] };

function bearer(token: string): string {
  return `Bearer ${token}`;
}

describe('verifyBearer', () => {
  it('accepts a valid, correctly signed token and returns its identity', () => {
    const token = jwt.sign({ sub: 'user-1', org_id: 'org-1' }, secret, { algorithm: 'HS256' });
    const identity = verifyBearer(bearer(token), options);
    expect(identity).toEqual({ userId: 'user-1', orgId: 'org-1' });
  });

  it('defaults orgId to null when the claim is absent', () => {
    const token = jwt.sign({ sub: 'user-2' }, secret, { algorithm: 'HS256' });
    expect(verifyBearer(bearer(token), options)).toEqual({ userId: 'user-2', orgId: null });
  });

  it('rejects an alg:none (unsigned) token', () => {
    const token = jwt.sign({ sub: 'user-1' }, '', { algorithm: 'none' });
    expect(() => verifyBearer(bearer(token), options)).toThrow(AuthError);
  });

  it('rejects a token signed with an algorithm outside the allowlist', () => {
    // Algorithm confusion: the token is validly signed, but with HS384 while the
    // server only trusts HS256. The allowlist must refuse it.
    const token = jwt.sign({ sub: 'user-1' }, secret, { algorithm: 'HS384' });
    expect(() => verifyBearer(bearer(token), options)).toThrow(AuthError);
  });

  it('rejects an expired token', () => {
    const token = jwt.sign({ sub: 'user-1' }, secret, { algorithm: 'HS256', expiresIn: -10 });
    expect(() => verifyBearer(bearer(token), options)).toThrow(AuthError);
  });

  it('rejects a token whose signature does not match the secret', () => {
    const token = jwt.sign({ sub: 'user-1' }, 'a-different-secret', { algorithm: 'HS256' });
    expect(() => verifyBearer(bearer(token), options)).toThrow(AuthError);
  });

  it('rejects a token with no subject claim', () => {
    const token = jwt.sign({ org_id: 'org-1' }, secret, { algorithm: 'HS256' });
    expect(() => verifyBearer(bearer(token), options)).toThrow(AuthError);
  });

  it('rejects a missing Authorization header', () => {
    expect(() => verifyBearer(undefined, options)).toThrow(AuthError);
  });

  it('rejects a non-Bearer Authorization header', () => {
    expect(() => verifyBearer('Basic abc', options)).toThrow(AuthError);
  });

  it('never accepts none even if none is somehow in the configured algorithms', () => {
    const token = jwt.sign({ sub: 'user-1' }, '', { algorithm: 'none' });
    expect(() => verifyBearer(bearer(token), { secret, algorithms: ['none'] })).toThrow(AuthError);
  });
});

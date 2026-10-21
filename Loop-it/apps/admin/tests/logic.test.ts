import { describe, expect, it } from 'vitest';
import { canUseAdmin, destructiveActionLabel, isOperatorToken, requiresConfirmation } from '../src/api';

describe('admin critical logic', () => {
  it('gates the console to owner/admin roles', () => {
    expect(canUseAdmin('owner')).toBe(true);
    expect(canUseAdmin('admin')).toBe(true);
    expect(canUseAdmin('member')).toBe(false);
    expect(canUseAdmin('viewer')).toBe(false);
    expect(canUseAdmin(null)).toBe(false);
  });

  it('requires confirmation for destructive actions', () => {
    expect(requiresConfirmation('kill_sandbox')).toBe(true);
    expect(requiresConfirmation('suspend_tenant')).toBe(true);
    expect(requiresConfirmation('global_pause')).toBe(true);
    expect(requiresConfirmation('refresh')).toBe(false);
    expect(destructiveActionLabel('kill_sandbox')).toBe('Kill sandbox');
  });

  it('recognizes only operator-audience platform tokens', () => {
    const operator = token({ iss: 'loopit-operator', aud: 'loopit-platform-operator', scopes: ['platform:operate'] });
    const customerWithScope = token({ iss: 'loopit-gateway', aud: 'loopit-control-plane', scopes: ['platform:operate'] });
    const config = {
      apiBaseUrl: 'http://abuse-engine:8007',
      operatorAudience: 'loopit-platform-operator',
      operatorIssuer: 'loopit-operator',
    };

    expect(isOperatorToken(operator, config)).toBe(true);
    expect(isOperatorToken(customerWithScope, config)).toBe(false);
    expect(isOperatorToken('not-a-token', config)).toBe(false);
  });
});

function token(payload: Record<string, unknown>): string {
  return ['header', btoa(JSON.stringify(payload)), 'signature'].join('.');
}

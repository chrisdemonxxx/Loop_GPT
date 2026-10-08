/**
 * Egress policy types (Doc 02 §5, invariants I3 and I4).
 *
 * The policy is default-deny and there is no way to express anything else:
 * `default_action` is the literal `'deny'`, not a union. A misconfiguration that
 * opens the sandbox to the internet is therefore a type error rather than a
 * runtime discovery.
 *
 * Enforcement lives in `services/egress-proxy`. These types are the shape the
 * control plane builds and hands to it — never the enforcement itself.
 */

export type EgressCategoryName =
  'package_registries' | 'model_router' | 'app_apis' | 'deploy_targets'

export type EgressWindow = 'always' | 'deploy_step_only' | 'named_step_only'

export interface EgressCategory {
  name: EgressCategoryName
  enabled: boolean
  /** When the category is open. `deploy_targets` is only ever `deploy_step_only`. */
  window?: EgressWindow
}

export interface EgressPolicy {
  /** Fixed. There is no allow-all posture, so this is not a configurable union. */
  default_action: 'deny'
  categories: EgressCategory[]
  /** Per-project, reviewed, opt-in domains. Logged on every request. */
  extra_allow?: string[]
  /** Always true. Unlogged egress cannot be investigated after an incident. */
  log_all_requests?: true
}

/**
 * Ranges that are denied unconditionally and cannot be re-enabled by any policy.
 *
 * The cloud metadata endpoint is first for a reason: reaching it from inside a
 * sandbox converts a code-execution foothold into the host's IAM role, which is
 * the single highest-severity escape in this architecture (invariant I4).
 */
export const ALWAYS_DENIED_CIDRS: readonly string[] = [
  '169.254.0.0/16', // link-local, incl. 169.254.169.254 cloud metadata
  'fd00:ec2::/32', // IMDSv6
  'fe80::/10', // IPv6 link-local
  '127.0.0.0/8', // loopback
  '::1/128',
  '10.0.0.0/8', // RFC1918
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10', // CGNAT
] as const

export interface EgressPolicyError {
  code: 'deploy-window' | 'wildcard-domain' | 'logging-disabled'
  message: string
}

/**
 * Checks the rules the JSON Schema can only partly express.
 *
 * Kept separate from the type so a policy loaded from configuration at runtime
 * gets the same scrutiny as one constructed in code.
 */
export function validateEgressPolicy(policy: EgressPolicy): EgressPolicyError[] {
  const errors: EgressPolicyError[] = []

  for (const category of policy.categories) {
    if (category.name === 'deploy_targets' && category.window !== 'deploy_step_only') {
      errors.push({
        code: 'deploy-window',
        message:
          "deploy_targets must use window 'deploy_step_only'; leaving it open outside a " +
          'deploy step gives every build step a path to production',
      })
    }
  }

  for (const domain of policy.extra_allow ?? []) {
    if (domain.startsWith('*.*') || domain.includes('**') || domain === '*') {
      errors.push({
        code: 'wildcard-domain',
        message: `'${domain}' is too broad to review; extra_allow entries must name a real domain`,
      })
    }
  }

  // The type pins this to `true`, but a policy loaded from configuration is
  // untrusted input and can carry anything, so it is checked at runtime too.
  if ((policy as { log_all_requests?: unknown }).log_all_requests === false) {
    errors.push({
      code: 'logging-disabled',
      message: 'egress logging cannot be disabled; unlogged egress is uninvestigable',
    })
  }

  return errors
}

/** The starting policy for a build lease: registries and the model router only. */
export function defaultBuildPolicy(): EgressPolicy {
  return {
    default_action: 'deny',
    categories: [
      { name: 'package_registries', enabled: true, window: 'always' },
      { name: 'model_router', enabled: true, window: 'always' },
      { name: 'app_apis', enabled: false, window: 'named_step_only' },
      { name: 'deploy_targets', enabled: false, window: 'deploy_step_only' },
    ],
    extra_allow: [],
    log_all_requests: true,
  }
}

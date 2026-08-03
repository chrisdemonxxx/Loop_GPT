import type { Metadata } from 'next'
import LegalLayout from '../components/LegalLayout'

export const metadata: Metadata = { title: 'Cookie Policy — Loop GPT' }

export default function CookiesPage() {
  return (
    <LegalLayout title="Cookie Policy" updated="August 3, 2026">
      <p>
        This Cookie Policy explains what cookies and similar technologies Loop GPT uses, why
        we use them, and how you can control them.
      </p>

      <h2>1. What Are Cookies?</h2>
      <p>
        Cookies are small text files placed on your device by a website. They allow the site
        to remember information about your visit, such as your login session and preferences.
        Similar technologies include local storage, session storage, and browser fingerprinting.
      </p>

      <h2>2. Cookies We Use</h2>

      <table>
        <thead>
          <tr>
            <th style={{ paddingRight: '1.5rem' }}>Name / Type</th>
            <th style={{ paddingRight: '1.5rem' }}>Purpose</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ paddingRight: '1.5rem' }}><strong>auth_token</strong> (Essential)</td>
            <td style={{ paddingRight: '1.5rem' }}>Keeps you signed in between sessions.</td>
            <td>7 days</td>
          </tr>
          <tr>
            <td style={{ paddingRight: '1.5rem' }}><strong>session</strong> (Essential)</td>
            <td style={{ paddingRight: '1.5rem' }}>Maintains your active session state.</td>
            <td>Browser session</td>
          </tr>
          <tr>
            <td style={{ paddingRight: '1.5rem' }}><strong>csrf_token</strong> (Essential)</td>
            <td style={{ paddingRight: '1.5rem' }}>Protects against cross-site request forgery.</td>
            <td>Browser session</td>
          </tr>
          <tr>
            <td style={{ paddingRight: '1.5rem' }}><strong>analytics</strong> (Analytics)</td>
            <td style={{ paddingRight: '1.5rem' }}>Anonymised usage analytics to improve the Service.</td>
            <td>1 year</td>
          </tr>
          <tr>
            <td style={{ paddingRight: '1.5rem' }}><strong>preferences</strong> (Functional)</td>
            <td style={{ paddingRight: '1.5rem' }}>Stores UI preferences (e.g. sidebar state).</td>
            <td>1 year</td>
          </tr>
        </tbody>
      </table>

      <h2>3. Local Storage</h2>
      <p>
        We also use browser <strong>local storage</strong> to persist your authentication
        token and UI state across sessions. Local storage is not a cookie but works similarly.
        It is cleared when you sign out or delete your browser data.
      </p>

      <h2>4. Third-Party Cookies</h2>
      <p>
        Some third-party services we integrate with may set their own cookies:
      </p>
      <ul>
        <li><strong>Google / GitHub OAuth</strong> — cookies set during social sign-in flow, governed by Google&apos;s and GitHub&apos;s own cookie policies.</li>
        <li><strong>Stripe</strong> — cookies for payment processing and fraud prevention.</li>
      </ul>
      <p>
        We do not serve advertising cookies or share data with advertising networks.
      </p>

      <h2>5. Your Choices</h2>
      <p>You can control cookies in the following ways:</p>
      <ul>
        <li>
          <strong>Browser settings</strong> — most browsers let you block or delete cookies.
          Note that blocking essential cookies will prevent you from signing in.
        </li>
        <li>
          <strong>Sign out</strong> — signing out clears your session and auth cookies.
        </li>
        <li>
          <strong>Delete account</strong> — deleting your account from{' '}
          <a href="/account">Account Settings</a> removes all associated data.
        </li>
      </ul>
      <p>
        Browser-specific instructions for managing cookies:
        <a href="https://support.google.com/chrome/answer/95647" target="_blank" rel="noreferrer"> Chrome</a>,{' '}
        <a href="https://support.mozilla.org/en-US/kb/enhanced-tracking-protection-firefox-desktop" target="_blank" rel="noreferrer">Firefox</a>,{' '}
        <a href="https://support.apple.com/guide/safari/manage-cookies-sfri11471/mac" target="_blank" rel="noreferrer">Safari</a>.
      </p>

      <h2>6. Do Not Track</h2>
      <p>
        Some browsers send a &ldquo;Do Not Track&rdquo; (DNT) signal. We honour DNT signals by disabling
        non-essential analytics cookies when a DNT signal is detected.
      </p>

      <h2>7. Changes to This Policy</h2>
      <p>
        We may update this Cookie Policy from time to time. Changes take effect when posted.
        Continued use of the Service constitutes acceptance of the updated policy.
      </p>

      <h2>8. Contact</h2>
      <p>
        Questions? Email us at <a href="mailto:privacy@loopgpt.ai">privacy@loopgpt.ai</a>.
      </p>
    </LegalLayout>
  )
}

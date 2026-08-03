import type { Metadata } from 'next'
import LegalLayout from '../components/LegalLayout'

export const metadata: Metadata = { title: 'Terms of Service — Loop GPT' }

export default function TermsPage() {
  return (
    <LegalLayout title="Terms of Service" updated="August 3, 2026">
      <p>
        Please read these Terms of Service (&ldquo;Terms&rdquo;) carefully before using Loop GPT
        (&ldquo;Service,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;). By creating an account or using the Service,
        you agree to be bound by these Terms. If you do not agree, do not use the Service.
      </p>

      <h2>1. Eligibility</h2>
      <p>
        You must be at least 13 years old (or 16 in the EU/EEA) to use the Service. By using
        the Service you represent that you meet this requirement and that all information you
        provide is accurate and complete.
      </p>

      <h2>2. Your Account</h2>
      <ul>
        <li>You are responsible for maintaining the confidentiality of your credentials.</li>
        <li>You are responsible for all activity that occurs under your account.</li>
        <li>Notify us immediately at <a href="mailto:support@loopgpt.ai">support@loopgpt.ai</a> if you suspect unauthorised access.</li>
        <li>You may not share, sell, or transfer your account to another person.</li>
        <li>You may not create more than one free account per person.</li>
      </ul>

      <h2>3. Description of Service</h2>
      <p>
        Loop GPT provides an AI-powered chat interface with agentic tool use, deep research,
        image generation, document creation, and related features (collectively, the &ldquo;Service&rdquo;).
        The Service relies on third-party AI inference providers whose outputs may occasionally
        be inaccurate, incomplete, or inappropriate. You are solely responsible for how you
        use AI-generated content.
      </p>

      <h2>4. Acceptable Use</h2>
      <p>
        Your use of the Service is governed by our <a href="/acceptable-use">Acceptable Use Policy</a>,
        which is incorporated into these Terms by reference. Violations may result in suspension
        or termination of your account.
      </p>

      <h2>5. Content You Submit</h2>
      <ul>
        <li>You retain ownership of content you submit (&ldquo;User Content&rdquo;).</li>
        <li>You grant us a limited licence to process and transmit your User Content solely to provide the Service.</li>
        <li>You represent that you have all rights necessary to submit your User Content and that it does not infringe any third party&apos;s rights.</li>
        <li>We do not use your User Content to train AI models without your explicit opt-in consent.</li>
      </ul>

      <h2>6. AI-Generated Content</h2>
      <p>
        AI-generated outputs are provided &ldquo;as is.&rdquo; We make no warranties regarding their
        accuracy, completeness, or fitness for a particular purpose. Do not rely on AI outputs
        for medical, legal, financial, or safety-critical decisions without independent
        professional verification.
      </p>

      <h2>7. Fees and Billing</h2>
      <ul>
        <li>Certain features require a paid subscription (&ldquo;Pro Plan&rdquo;).</li>
        <li>Fees are charged in advance on a monthly or annual basis.</li>
        <li>All fees are non-refundable except where required by law or at our sole discretion.</li>
        <li>We reserve the right to change pricing with 30 days&apos; notice.</li>
        <li>If your payment method fails, we may suspend access until payment is resolved.</li>
      </ul>

      <h2>8. SMS Communications</h2>
      <p>
        By providing your mobile phone number and opting in to SMS communications, you agree
        to the following terms governing our text messaging program.
      </p>

      <h3>Consent and opt-in</h3>
      <p>
        By furnishing your mobile number and indicating your consent (via the SMS opt-in
        checkbox at registration or in Account Settings), you expressly consent to receive
        text messages from Loop GPT at the mobile number provided. Consent is not a condition
        of purchasing any goods or services. Standard texting consent rules apply: you must be
        the account holder or have the account holder&apos;s permission for the number you provide.
      </p>

      <h3>Types of messages</h3>
      <p>
        We send the following categories of SMS messages to opted-in users:
      </p>
      <ul>
        <li><strong>Transactional / security</strong> — one-time passcodes (OTPs) for two-factor authentication, password-reset codes, and login alerts.</li>
        <li><strong>Account notifications</strong> — billing confirmations, subscription renewal reminders, and usage limit warnings.</li>
        <li><strong>Support</strong> — responses to support requests you initiate via SMS.</li>
      </ul>

      <h3>Message frequency</h3>
      <p>
        Message frequency varies and depends on your account activity. Transactional messages
        (OTPs, security alerts) are triggered solely by your own actions. Account notification
        messages are sent infrequently, typically no more than a few times per billing period.
        We will not send messages in excess of what is necessary to deliver the requested service.
      </p>

      <h3>Message and data rates</h3>
      <p>
        <strong>Message and data rates may apply.</strong> Loop GPT does not charge for SMS
        messages, but your mobile carrier may charge for messages sent to or received from
        short codes or long codes according to your plan. Contact your carrier for details.
      </p>

      <h3>How to opt out — STOP</h3>
      <p>
        You may opt out of SMS communications at any time by replying <strong>STOP</strong> to
        any message from us. Upon receipt of your STOP request, we will send a single
        confirmation message and immediately cease all non-required SMS to that number.
        You may also disable SMS notifications in your{' '}
        <a href="/account">Account Settings</a>. If you opt out of security-related messages
        (such as OTPs), certain account security features may be unavailable to you.
      </p>

      <h3>How to get help — HELP</h3>
      <p>
        Reply <strong>HELP</strong> to any of our messages to receive a response with contact
        information and opt-out instructions. You can also reach us at{' '}
        <a href="mailto:support@loopgpt.ai">support@loopgpt.ai</a>.
      </p>

      <h3>Supported carriers</h3>
      <p>
        SMS messages are delivered through major US carriers including AT&amp;T, T-Mobile,
        Verizon, Sprint, and others. Carrier participation may vary; we are not responsible
        for delayed or undelivered messages due to carrier issues.
      </p>

      <h3>No sharing for marketing</h3>
      <p>
        <strong>
          Mobile phone numbers collected for SMS communications will not be shared with,
          sold to, or rented to any third party or affiliate for marketing or promotional
          purposes.
        </strong>{' '}
        Phone numbers are disclosed only to our SMS delivery provider (for the sole purpose of
        transmitting your messages), as required by law, or to prevent fraud or abuse.
      </p>

      <h2>9. Intellectual Property</h2>
      <p>
        The Service, including its design, software, and branding, is owned by Loop GPT and
        protected by copyright, trademark, and other laws. You may not copy, modify, distribute,
        or create derivative works from any part of the Service without our written permission.
      </p>

      <h2>10. Third-Party Services</h2>
      <p>
        The Service integrates with third-party providers including AI model providers, OAuth
        providers, and payment processors. Your use of those services is governed by their own
        terms and policies. We are not responsible for third-party services.
      </p>

      <h2>11. Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND,
        EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS
        FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE
        WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.
      </p>

      <h2>12. Limitation of Liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, LOOP GPT SHALL NOT BE LIABLE FOR ANY INDIRECT,
        INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS,
        REVENUE, DATA, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH THE SERVICE OR THESE
        TERMS, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR TOTAL LIABILITY TO YOU
        FOR ANY CLAIMS ARISING UNDER THESE TERMS SHALL NOT EXCEED THE AMOUNT YOU PAID US IN
        THE 12 MONTHS PRECEDING THE CLAIM, OR USD $50, WHICHEVER IS GREATER.
      </p>

      <h2>13. Indemnification</h2>
      <p>
        You agree to indemnify and hold harmless Loop GPT and its officers, directors,
        employees, and agents from any claims, damages, or expenses (including reasonable
        attorneys&apos; fees) arising out of your use of the Service, your User Content, or your
        violation of these Terms.
      </p>

      <h2>14. Termination</h2>
      <p>
        We may suspend or terminate your access to the Service at any time, with or without
        cause, with or without notice. You may terminate your account at any time from{' '}
        <a href="/account">Account Settings</a>. Provisions that by their nature should
        survive termination will survive (including Sections 9, 11, 12, and 13).
      </p>

      <h2>15. Governing Law and Disputes</h2>
      <p>
        These Terms are governed by the laws of the State of Delaware, United States, without
        regard to conflict-of-law provisions. Any dispute shall be resolved by binding
        arbitration under the rules of the American Arbitration Association, except that either
        party may seek injunctive relief in a court of competent jurisdiction.
      </p>

      <h2>16. Changes to These Terms</h2>
      <p>
        We may update these Terms at any time. We will notify you of material changes by
        email or by a notice in the Service. Continued use after the effective date constitutes
        acceptance of the revised Terms.
      </p>

      <h2>17. Contact</h2>
      <p>
        Questions about these Terms? Contact us at <a href="mailto:legal@loopgpt.ai">legal@loopgpt.ai</a>.
      </p>
    </LegalLayout>
  )
}

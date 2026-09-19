import type { Metadata } from 'next'
import LegalLayout from '../components/LegalLayout'

export const metadata: Metadata = { title: 'Acceptable Use Policy — Loop GPT' }

export default function AcceptableUsePage() {
  return (
    <LegalLayout title="Acceptable Use Policy" updated="August 3, 2026">
      <p>
        This Acceptable Use Policy (&ldquo;AUP&rdquo;) describes what you may and may not do with the
        Loop GPT Service. By using the Service, you agree to comply with this AUP. Violations
        may result in suspension or permanent termination of your account.
      </p>

      <h2>1. Prohibited Content</h2>
      <p>You may not use the Service to generate, transmit, or store:</p>
      <ul>
        <li>Child sexual abuse material (CSAM) or any sexual content involving minors, real or fictional.</li>
        <li>Non-consensual intimate imagery (&ldquo;deepfakes&rdquo;) of real people.</li>
        <li>Content that threatens, harasses, or incites violence against specific individuals or groups.</li>
        <li>Malware, viruses, ransomware, or other malicious code.</li>
        <li>Content that infringes third-party intellectual property rights.</li>
        <li>Defamatory, fraudulent, or deceptive content intended to mislead others.</li>
        <li>Content that promotes or facilitates terrorism, mass violence, or genocide.</li>
      </ul>

      <h2>2. Prohibited Uses</h2>
      <p>You may not use the Service to:</p>
      <ul>
        <li><strong>Automated abuse</strong> — run bulk, automated, or scripted requests that place excessive load on the Service beyond what the API is designed for.</li>
        <li><strong>Credential harvesting</strong> — phish for or scrape credentials, passwords, or personal data.</li>
        <li><strong>Circumvent safety measures</strong> — attempt to bypass content filters, rate limits, or authentication controls.</li>
        <li><strong>Impersonate</strong> — impersonate Loop GPT, our staff, or any other person or organisation.</li>
        <li><strong>Re-sell access</strong> — resell or sub-license access to the Service without our written permission.</li>
        <li><strong>Competitive intelligence</strong> — systematically scrape or extract the Service to build a competing product.</li>
        <li><strong>Illegal activity</strong> — engage in any activity that violates applicable local, national, or international law.</li>
        <li><strong>Generate disinformation at scale</strong> — produce synthetic media designed to deceive the public about real events or people.</li>
      </ul>

      <h2>3. AI Safety</h2>
      <p>
        The Service includes AI models that can produce powerful outputs. You are responsible
        for ensuring your use of AI-generated content complies with applicable law and does not
        cause harm. Do not use AI-generated outputs to:
      </p>
      <ul>
        <li>Provide medical diagnoses or replace professional medical advice.</li>
        <li>Provide legal advice that could prejudice legal proceedings.</li>
        <li>Operate safety-critical systems (aviation, medical devices, nuclear) without qualified human oversight.</li>
        <li>Make high-stakes financial decisions without independent verification.</li>
      </ul>

      <h2>4. Responsible Research &amp; Security</h2>
      <p>
        We support legitimate security research and educational use. You may use the Service
        for authorised penetration testing, CTF competitions, security research, and defensive
        tooling. You may <strong>not</strong> use the Service to:
      </p>
      <ul>
        <li>Develop cyberweapons or malware intended for malicious deployment.</li>
        <li>Conduct denial-of-service attacks against any system.</li>
        <li>Compromise systems without explicit owner authorisation.</li>
      </ul>

      <h2>5. Resource Usage</h2>
      <p>
        Free and Pro plan limits apply as described in your plan. You may not circumvent
        these limits by creating multiple accounts, sharing credentials, or other means.
        Excessive resource consumption that degrades service for other users may result in
        rate limiting or account review.
      </p>

      <h2>6. Reporting Violations</h2>
      <p>
        If you become aware of content or behaviour that violates this AUP, please report it
        to <a href="mailto:abuse@loopgpt.ai">abuse@loopgpt.ai</a>. We investigate all reports
        and take appropriate action.
      </p>

      <h2>7. Enforcement</h2>
      <p>
        We reserve the right to remove content, suspend access, or permanently terminate
        accounts that violate this AUP, at our sole discretion and without prior notice.
        Severe violations (e.g. CSAM, active cyberattacks) will be reported to law enforcement.
      </p>

      <h2>8. Changes</h2>
      <p>
        We may update this AUP at any time. Continued use of the Service after changes are
        posted constitutes acceptance of the revised AUP.
      </p>

      <h2>9. Contact</h2>
      <p>
        Questions about this policy? Email <a href="mailto:legal@loopgpt.ai">legal@loopgpt.ai</a>.
      </p>
    </LegalLayout>
  )
}

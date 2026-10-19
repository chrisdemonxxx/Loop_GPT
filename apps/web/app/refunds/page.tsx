import type { Metadata } from 'next'
import LegalLayout from '../components/LegalLayout'

export const metadata: Metadata = { title: 'Refund & Cancellation Policy — Loop GPT' }

export default function RefundPolicyPage() {
  return (
    <LegalLayout title="Refund & Cancellation Policy" updated="October 19, 2026">
      <p>
        This Refund &amp; Cancellation Policy explains how subscriptions, monthly credit
        allowances, and prepaid top-up credits work across Loop GPT (&ldquo;Service&rdquo;),
        including web, desktop, mobile, and the <code>/v1</code> Developer API.
      </p>

      <h2>1. Monthly Subscriptions (Pro &amp; Max)</h2>
      <ul>
        <li>
          <strong>Cancel anytime:</strong> You may cancel your Pro ($20/month) or Max ($100/month)
          subscription at any time from your Account &amp; Billing portal. Cancellation stops future
          recurring renewals; your plan and monthly credit allowance remain active through the end of
          your current paid billing cycle.
        </li>
        <li>
          <strong>Monthly subscription credits:</strong> Credits included with a monthly subscription
          are spent first before any prepaid top-up balance and expire at the end of each monthly
          billing cycle (they do not roll over).
        </li>
        <li>
          <strong>Refund eligibility:</strong> If you request a refund within 7 days of an initial
          subscription charge and have consumed less than 10% of that cycle&apos;s credit allowance,
          we will issue a full refund upon request. Renewals and partially used cycles outside this
          window are non-refundable except where required by applicable consumer law (such as EU/UK
          statutory cooling-off rights).
        </li>
      </ul>

      <h2>2. Prepaid API &amp; Wallet Top-Ups</h2>
      <ul>
        <li>
          <strong>Rollover balance:</strong> One-time credit pack purchases ($10, $25, $100) never
          expire while your account remains in good standing and are only drawn after any active
          monthly subscription credits are exhausted.
        </li>
        <li>
          <strong>Unused top-up refunds:</strong> Totally unused prepaid credit packs may be
          refunded within 14 days of purchase. Once any portion of a top-up pack has been spent on
          metered inference, image/video generation, Bot computer minutes, or Build runs, the balance
          is non-refundable.
        </li>
      </ul>

      <h2>3. Mobile In-App Purchases (Apple App Store &amp; Google Play)</h2>
      <p>
        Purchases made through the iOS App Store or Google Play Store are billed and processed
        directly by Apple or Google. To request a refund for an in-app purchase, please use Apple&apos;s
        <code>reportaproblem.apple.com</code> portal or Google Play&apos;s order history support flow.
      </p>

      <h2>4. Chargebacks &amp; Disputes</h2>
      <p>
        Filing an unauthorized payment dispute or chargeback automatically suspends account and API
        entitlements pending resolution. If you believe a charge was made in error, please contact us
        first so we can resolve it promptly.
      </p>

      <h2>5. How to Request a Refund</h2>
      <p>
        Email <a href="mailto:billing@loop-gpt.cyou">billing@loop-gpt.cyou</a> with your account
        email address and the invoice or transaction reference. Verified refund requests are
        processed within 5–10 business days back to the original payment method.
      </p>
    </LegalLayout>
  )
}

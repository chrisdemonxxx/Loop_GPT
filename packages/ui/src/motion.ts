'use client'

import type { Transition, Variants } from 'framer-motion'

/**
 * Motion spec: ONE place for the app's animation language. No more
 * per-component ad-hoc tweens. All variants respect the global
 * <MotionConfig reducedMotion="user"> in providers.tsx — framer collapses
 * transforms automatically when the user prefers reduced motion.
 *
 * Language:
 *  - popovers/menus: quick ease-out, scale 0.98→1 + fade, origin at trigger
 *  - drawers/panels/sheets: spring, no bounce overshoot
 *  - lists: 40ms stagger, max 6 items so long lists don't feel laggy
 *  - content: short fade-up
 */

export const easeOut: Transition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
export const springPanel: Transition = { type: 'spring', stiffness: 400, damping: 32 }

/** Popover anchored to a trigger (menus, pickers, the Run settings popover). */
export const popover: Variants = {
  initial: { opacity: 0, scale: 0.98, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0, transition: easeOut },
  exit: { opacity: 0, scale: 0.98, y: -4, transition: { duration: 0.12, ease: 'easeIn' } },
}

/** Popover that opens UPWARD from the composer (menus above the input). */
export const popoverUp: Variants = {
  initial: { opacity: 0, scale: 0.98, y: 4 },
  animate: { opacity: 1, scale: 1, y: 0, transition: easeOut },
  exit: { opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.12, ease: 'easeIn' } },
}

/** Right-dock panel (Artifacts, Loop Bot run viewer). */
export const panelRight: Variants = {
  initial: { x: 24, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: springPanel },
  exit: { x: 24, opacity: 0, transition: { duration: 0.15, ease: 'easeIn' } },
}

/** Bottom sheet (mobile menus, mobile panels). */
export const sheetBottom: Variants = {
  initial: { y: 48, opacity: 0 },
  animate: { y: 0, opacity: 1, transition: springPanel },
  exit: { y: 48, opacity: 0, transition: { duration: 0.15, ease: 'easeIn' } },
}

/** Scrim behind sheets/drawers. */
export const scrim: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.15 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
}

/** Short content fade-up (empty states, cards entering). */
export const fadeUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
}

/** List container: 40ms stagger, capped so long lists stay snappy. */
export const listStagger: Variants = {
  animate: { transition: { staggerChildren: 0.04 } },
}

/** List item (pair with listStagger). */
export const listItem: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.16, ease: 'easeOut' } },
}

/** The streaming pulse ring on the send/stop button (CSS keyframes live in
 *  globals.css as .pulse-ring; this is the JS-driven scale used at mount). */
export const buttonPop: Variants = {
  initial: { scale: 0.9, opacity: 0 },
  animate: { scale: 1, opacity: 1, transition: { type: 'spring', stiffness: 500, damping: 26 } },
}
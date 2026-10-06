'use client'

import { useEffect } from 'react'
import { getPrefs } from '../lib/prefs'
import { startBreakReminders, notify } from '../lib/reminders'
import { useToast } from '../lib/toast'

/**
 * Time & focus engine (mounted once in Providers): runs the break-reminder
 * clock against live prefs and fires quiet-hours-gated notifications. When
 * the browser denies the Notification API the reminder falls back to a toast
 * so the feature still does what the toggle says.
 */
export function RemindersEngine() {
  const toast = useToast()
  useEffect(() => {
    const stop = startBreakReminders(getPrefs, () => {
      const mins = getPrefs().breakReminders.everyMinutes || 50
      void notify(getPrefs().quietHours, 'Time for a break', `You've been going for ${mins} minutes — stretch, water, eyes off the screen.`)
        .then((result) => {
          if (result === 'denied' || result === 'unsupported') {
            toast.push('info', `Time for a break — you've been going for ${mins} minutes`)
          }
          // 'quiet' = suppressed by quiet hours (the point); 'sent' already shown.
        })
    })
    return stop
  }, [toast])
  return null
}

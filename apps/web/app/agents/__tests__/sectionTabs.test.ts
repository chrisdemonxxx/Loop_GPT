import { expect, it } from 'vitest'
import { BOT_SECTION_TAB_CLASS } from '../sectionTabs'

/** 32px tap target. Tailwind min-h-8 is 2rem. */
it('bot section tabs meet the 32px tap target', () => {
  expect(BOT_SECTION_TAB_CLASS.split(/\s+/)).toContain('min-h-8')
})

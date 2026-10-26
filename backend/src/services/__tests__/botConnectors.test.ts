import { describe, expect, it } from 'vitest'
import { mergeConnectorTools } from '../botConnectors'

describe('bot connector grant', () => {
  it('adds the same enabled connector tools chat would get, and skips disabled names', () => {
    const names = mergeConnectorTools(
      ['web_search'],
      [
        { name: 'connector__gh1__list_issues', enabled: true },
        { name: 'connector__sl1__post', enabled: false },
        { name: 'web_search', enabled: true },
      ],
    )
    expect(names).toEqual(['web_search', 'connector__gh1__list_issues'])
  })
})

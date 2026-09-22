import { describe, expect, it } from 'vitest'
import { pickApi, buildArgs } from '../tools/gradio'

// Shape mirrors a real chain Space (`/run_chain`): text prompts + an optional
// reference image + knobs, returning an image and a video.
const chainInfo = {
  named_endpoints: {
    '/lambda': { parameters: [], returns: [] },
    '/frame_info': { parameters: [{ component: 'Slider', parameter_has_default: true, parameter_default: 5 }], returns: [] },
    '/run_chain': {
      parameters: [
        { label: 'Keyframe prompt', component: 'Textbox', type: { type: 'string' }, parameter_has_default: true, parameter_default: 'x' },
        { label: 'Negative prompt (keyframe)', component: 'Textbox', type: { type: 'string' }, parameter_has_default: true, parameter_default: '' },
        { label: 'Video / motion prompt', component: 'Textbox', type: { type: 'string' }, parameter_has_default: true, parameter_default: 'x' },
        { label: 'Mode', component: 'Radio', type: { enum: ['fl2va', 'ref2va'], type: 'string' }, parameter_has_default: true, parameter_default: 'fl2va' },
        { label: 'Reference person', component: 'Image', parameter_has_default: false },
        { label: 'Resolution', component: 'Radio', type: { enum: ['960x544', '1344x768'], type: 'string' }, parameter_has_default: true, parameter_default: '960x544' },
        { label: 'Duration (s)', component: 'Slider', parameter_has_default: true, parameter_default: 5 },
        { label: 'Seed', component: 'Number', parameter_has_default: true, parameter_default: 42 },
      ],
      returns: [{ component: 'Image' }, { component: 'Video' }, { component: 'Textbox' }],
    },
  },
}

describe('gradio endpoint selection', () => {
  it('picks the full chain over trivial endpoints', () => {
    const chosen = pickApi(chainInfo)!
    expect(chosen.api).toBe('/run_chain')
    expect(chosen.params.length).toBe(8)
  })

  it('returns null when there is nothing usable', () => {
    expect(pickApi({ named_endpoints: { '/lambda': { parameters: [] } } })).toBeNull()
    expect(pickApi({})).toBeNull()
  })
})

describe('gradio argument mapping', () => {
  it('maps the prompt to the first text box, blanks negatives, and passes the reference image', () => {
    const { params } = pickApi(chainInfo)!
    const args = buildArgs(params, 'a red fox in snow', 'BASE64')
    expect(args[0]).toBe('a red fox in snow')   // keyframe prompt
    expect(args[1]).toBe('')                     // negative
    expect(args[2]).toBe('a red fox in snow')    // motion prompt
    expect(args[3]).toBe('fl2va')               // radio default
    expect(args[4]).toBe('BASE64')              // reference image
    expect(args[7]).toBe(42)                     // seed default
  })

  it('uses null for the reference image when none is supplied', () => {
    const { params } = pickApi(chainInfo)!
    expect(buildArgs(params, 'p')[4]).toBeNull()
  })
})

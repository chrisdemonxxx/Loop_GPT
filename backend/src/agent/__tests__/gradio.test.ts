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

// Shape mirrors the live red-kit/nsfw-media-studio Space: /generate_video is a
// pure image-to-video (start frame required); /image_to_video is the chained
// text→image→video endpoint. Routing must respect whether we HAVE an image.
const studioInfo = {
  named_endpoints: {
    '/generate_image': {
      parameters: [{ label: 'Prompt', component: 'Textbox', type: { type: 'string' } }],
      returns: [{ component: 'Image' }],
    },
    '/image_to_video': {
      parameters: [
        { label: 'Image prompt', component: 'Textbox', type: { type: 'string' } },
        { label: 'Video prompt', component: 'Textbox', type: { type: 'string' } },
      ],
      returns: [{ component: 'Image' }, { component: 'Video' }],
    },
    '/generate_video': {
      parameters: [
        { label: 'Start frame', component: 'Image' },
        { label: 'Motion prompt', component: 'Textbox', type: { type: 'string' } },
      ],
      returns: [{ component: 'Video' }],
    },
  },
}

describe('gradio video routing with/without a start frame', () => {
  it('text-only video routes to the chained /image_to_video endpoint', () => {
    const chosen = pickApi(studioInfo, 'video', false)!
    expect(chosen.api).toBe('/image_to_video')
  })

  it('video with a reference image routes to the direct /generate_video endpoint', () => {
    const chosen = pickApi(studioInfo, 'video', true)!
    expect(chosen.api).toBe('/generate_video')
  })

  it('image mode still prefers the image-returning endpoint', () => {
    const chosen = pickApi(studioInfo, 'image', false)!
    expect(chosen.api).toBe('/generate_image')
  })

  it('edit (ref2lock) mode prefers the endpoint that takes AND returns an image', () => {
    const chosen = pickApi(studioEditInfo, 'edit', true)!
    expect(chosen.api).toBe('/edit_image')
  })
})

// The live media studio shape after the ref2lock endpoint landed.
const studioEditInfo = {
  named_endpoints: {
    '/generate_image': {
      parameters: [{ label: 'Prompt', component: 'Textbox', type: { type: 'string' } }],
      returns: [{ component: 'Image' }],
    },
    '/edit_image': {
      parameters: [
        { label: 'Reference', component: 'Image' },
        { label: 'Edit prompt', component: 'Textbox', type: { type: 'string' } },
        { label: 'Strength (identity lock)', component: 'Slider', parameter_has_default: true, parameter_default: 0.6 },
        { label: 'Steps', component: 'Slider', parameter_has_default: true, parameter_default: 28 },
      ],
      returns: [{ component: 'Image' }],
    },
    '/generate_video': {
      parameters: [
        { label: 'Start frame', component: 'Image' },
        { label: 'Motion prompt', component: 'Textbox', type: { type: 'string' } },
      ],
      returns: [{ component: 'Video' }],
    },
  },
}

describe('ref2lock strength mapping', () => {
  it('honours the caller strength on the identity-lock slider', () => {
    const { params } = pickApi(studioEditInfo, 'edit', true)!
    const args = buildArgs(params, 'the same woman, topless on a beach', 'BASE64', { strength: 0.55 })
    expect(args[0]).toEqual({ url: 'data:image/png;base64,BASE64', orig_name: 'reference.png', meta: { _type: 'gradio.FileData' } })
    expect(args[1]).toBe('the same woman, topless on a beach')
    expect(args[2]).toBe(0.55)   // identity-lock strength
    expect(args[3]).toBe(28)     // steps default
  })

  it('falls back to the endpoint default when no strength is given', () => {
    const { params } = pickApi(studioEditInfo, 'edit', true)!
    expect(buildArgs(params, 'p', 'BASE64')[2]).toBe(0.6)
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
    expect(args[4]).toEqual({ url: 'data:image/png;base64,BASE64', orig_name: 'reference.png', meta: { _type: 'gradio.FileData' } }) // reference image as FileData
    expect(args[7]).toBe(42)                     // seed default
  })

  it('uses null for the reference image when none is supplied', () => {
    const { params } = pickApi(chainInfo)!
    expect(buildArgs(params, 'p')[4]).toBeNull()
  })
})

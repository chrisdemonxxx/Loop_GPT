---
name: media-prompt-craft
description: Craft high-impact prompts for generate_image and generate_video. Use when the user asks to create, illustrate, animate, or visualize anything, or when a media prompt needs more visual detail, style, camera language, or motion design.
---

# Media Prompt Craft

When generating images or videos, build prompts as **scene descriptions**, not requests.

## Image prompts (generate_image)

Structure: `subject + action + setting + lighting + style + composition`

- Name the subject with visual specifics ("a weathered fisherman in a yellow slicker", not "a man")
- Set the scene with light: "golden hour rim light", "overcast diffuse light", "neon glow from signage"
- Pick a style anchor: "editorial photography", "matte painting", "isometric 3D render", "ink and watercolor"
- Compose: "low-angle hero shot", "centered symmetrical portrait", "wide establishing view"

Example transformation:
- Weak: "a cool city"
- Strong: "futuristic megacity at sunset, layered skybridges with hanging gardens, warm haze between glass towers, low sun flaring off chrome, cinematic wide shot, matte-painting style"

Always pass explicit `width`/`height` when the user implies orientation (portrait 1024x1280, landscape 1280x1024, square 1024x1024).

## Video prompts (generate_video)

Motion is the subject. Structure: `scene + subject motion + camera motion + mood`

- One clear primary motion ("waves curling and crashing", "steam rising from a ramen bowl", "a paper boat drifting downstream")
- Add camera intent: "slow dolly forward", "static tripod shot", "gentle orbit"
- Note pacing: "slow and dreamy", "brisk energy"
- Keep scenes simple — short clips render best with a single focal motion

Example: "morning fog rolling over pine forest, slow aerial drift forward, soft dawn light, calm cinematic mood"

## Delivery rules

- After generating, present the result inline and offer one refinement ("want it more photoreal, or a different palette?")
- If the endpoint is cold (first request after idle), warn the user generation may take 1–3 minutes for video
- Never mention underlying model or infrastructure names — the product is Loop GPT media generation

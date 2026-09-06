#!/usr/bin/env node
/**
 * Loop GPT MCP media server (stdio) — real image + video generation tools
 * backed by our HuggingFace Inference Endpoints.
 *
 * Env required (injected by the container):
 *   HF_TOKEN       HuggingFace bearer token
 *   HF_IMAGE_URL   image endpoint URL
 *   HF_VIDEO_URL   video endpoint URL
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_IMAGE_URL = (process.env.HF_IMAGE_URL || '').replace(/\/+$/, '');
const HF_VIDEO_URL = (process.env.HF_VIDEO_URL || '').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logErr(tag, err) {
  // stderr only — stdout is the MCP channel
  console.error(`[${tag}] ${err?.message || err}`);
}

async function withColdStartRetry(fn, { tries = 12, delayMs = 25000, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!/50[234]|timeout|ECONNRESET|fetch failed/i.test(msg)) throw e;
      onRetry?.(i, msg);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/** Call image endpoint; accept raw PNG bytes, {image:b64}, or OpenAI-ish envelopes. */
async function generateImage(prompt, opts = {}) {
  return withColdStartRetry(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 280000);
    try {
      const res = await fetch(HF_IMAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json,image/png',
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            width: Math.min(Math.max(opts.width || 1024, 256), 2048),
            height: Math.min(Math.max(opts.height || 1024, 256), 2048),
            num_inference_steps: 28,
            guidance_scale: 3.5,
          },
        }),
        signal: ctrl.signal,
      });
      if ([502, 503, 504].includes(res.status)) {
        throw new Error(String(res.status));
      }
      if (!res.ok) {
        const txt = (await res.text()).slice(0, 300);
        throw new Error(`image endpoint HTTP ${res.status}: ${txt}`);
      }
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { mime: ctype, b64: buf.toString('base64'), bytes: buf.length };
      }
      const json = await res.json();
      const pick =
        json?.image ||
        json?.data?.[0]?.b64_json ||
        json?.data?.[0]?.image ||
        json?.output?.[0]?.image ||
        json?.artifacts?.[0]?.base64;
      let s = typeof pick === 'string' ? pick : '';
      if (s.startsWith('data:')) s = s.slice(s.indexOf(',') + 1);
      if (!s) throw new Error(`unexpected image response shape: ${JSON.stringify(json).slice(0, 300)}`);
      return { mime: 'image/png', b64: s, bytes: Math.round((s.length * 3) / 4) };
    } finally {
      clearTimeout(t);
    }
  });
}

/** Submit video job; poll status/result URLs. */
async function generateVideo(prompt, { fps = 24, numFrames = 49, width = 832, height = 480 } = {}) {
  return withColdStartRetry(
    async () => {
      const submitRes = await fetch(`${HF_VIDEO_URL}/api/generate-video`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { fps, num_frames: numFrames, width, height },
        }),
      }).catch(async (e) => {
        logErr('video-submit', e);
        return null;
      });

      let sub = null;
      if (submitRes && submitRes.ok) {
        sub = await submitRes.json().catch(() => null);
      }
      // Root-POST fallback (HF style) when /api/generate-video misses
      if (!sub) {
        const rootRes = await fetch(HF_VIDEO_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { fps, num_frames: numFrames, width, height },
          }),
        });
        if ([502, 503, 504].includes(rootRes.status)) throw new Error(String(rootRes.status));
        if (!rootRes.ok) {
          const txt = (await rootRes.text()).slice(0, 300);
          throw new Error(`video submit HTTP ${rootRes.status}: ${txt}`);
        }
        const ctype = rootRes.headers.get('content-type') || '';
        if (ctype.includes('video/') || ctype.includes('octet-stream')) {
          const buf = Buffer.from(await rootRes.arrayBuffer());
          return { mime: 'video/mp4', b64: buf.toString('base64'), bytes: buf.length };
        }
        sub = await rootRes.json().catch(() => null);
        if (!sub) throw new Error('video submit returned unparsable body');
      }

      const statusUrl = sub.status_url || sub.statusUrl || null;
      const resultUrl = sub.result_url || sub.resultUrl || null;
      const jobId = sub.job_id || sub.task_id || sub.id || null;

      const mkUrl = (u) => (u && /^https?:/.test(u) ? u : jobId ? `${HF_VIDEO_URL}/api/jobs/${jobId}/status` : null);

      // Direct mp4 already returned
      const directB64 = sub.video_b64 || sub.base64 || (typeof sub.output === 'string' ? sub.output : null);
      if (directB64) {
        let s = directB64.startsWith('data:') ? directB64.slice(directB64.indexOf(',') + 1) : directB64;
        return { mime: 'video/mp4', b64: s, bytes: Math.round((s.length * 3) / 4) };
      }

      const deadline = Date.now() + 9 * 60 * 1000;
      const statBase = statusUrl ? mkUrl(statusUrl) : jobId ? `${HF_VIDEO_URL}/api/jobs/${jobId}` : null;
      let replica404 = 0;
      while (Date.now() < deadline) {
        await sleep(15000);
        let cur = null;
        if (statBase) {
          const r = await fetch(statBase, { headers: { Authorization: `Bearer ${HF_TOKEN}` } }).catch((e) => {
            logErr('video-poll', e);
            return null;
          });
          if (r && r.ok) cur = await r.json().catch(() => null);
          else if (r && r.status === 404) {
            replica404++;
          }
        }
        const st = (cur?.status || sub.status || 'processing').toLowerCase();
        if (st === 'completed' || st === 'succeeded' || cur?.result) {
          const rUrl = cur?.result_url || cur?.result?.url || resultUrl;
          if (rUrl) {
            const rr = await fetch(/^https?:/.test(rUrl) ? rUrl : `${HF_VIDEO_URL}${rUrl}`, {
              headers: { Authorization: `Bearer ${HF_TOKEN}` },
            });
            const ct = rr.headers.get('content-type') || 'video/mp4';
            if (ct.includes('video/') || ct.includes('octet-stream')) {
              const buf = Buffer.from(await rr.arrayBuffer());
              return { mime: 'video/mp4', b64: buf.toString('base64'), bytes: buf.length };
            }
            const jj = await rr.json().catch(() => null);
            const b = jj?.video_b64 || jj?.b64 || jj?.base64;
            if (b) {
              const s = b.startsWith('data:') ? b.slice(b.indexOf(',') + 1) : b;
              return { mime: 'video/mp4', b64: s, bytes: Math.round((s.length * 3) / 4) };
            }
          }
        }
        if (st === 'failed' || st === 'error') {
          throw new Error(cur?.error || 'video generation reported failure');
        }
      }
      throw new Error('video generation timed out after 9 minutes (endpoint may still be warming)');
    },
    { tries: 2, delayMs: 60000 }
  );
}

const server = new McpServer({ name: 'loop-media', version: '0.1.0' });

server.tool(
  'generate_image',
  'Generate an image from a text prompt using Loop GPT image generation.',
  {
    prompt: z.string().describe('Describe the image to generate'),
    width: z.number().optional(),
    height: z.number().optional(),
  },
  async ({ prompt, width, height }) => {
    if (!HF_IMAGE_URL || !HF_TOKEN) return { content: [{ type: 'text', text: 'Server missing HF_IMAGE_URL/HF_TOKEN config.' }] };
    try {
      const img = await generateImage(prompt, { width, height });
      return {
        content: [
          { type: 'image', data: img.b64, mimeType: img.mime },
          { type: 'text', text: `Generated image (${Math.round(img.bytes / 1024)} KB) for prompt: "${prompt}"` },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Image generation failed: ${e?.message || e}` }] };
    }
  }
);

server.tool(
  'generate_video',
  'Generate a short video clip from a text prompt using Loop GPT video generation (may take several minutes).',
  {
    prompt: z.string().describe('Describe the scene to animate'),
  },
  async ({ prompt }) => {
    if (!HF_VIDEO_URL || !HF_TOKEN) return { content: [{ type: 'text', text: 'Server missing HF_VIDEO_URL/HF_TOKEN config.' }] };
    try {
      const vid = await generateVideo(prompt);
      const sizeMB = (vid.bytes / 1048576).toFixed(1);
      // Preferred path: publish to the media CDN and return a playable URL.
      if (process.env.MEDIA_PUBLISH_URL && process.env.MEDIA_PUBLISH_KEY) {
        try {
          const pub = await fetch(process.env.MEDIA_PUBLISH_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.MEDIA_PUBLISH_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ mime: 'video/mp4', b64: vid.b64, name: 'loop-video.mp4' }),
          });
          if (pub.ok) {
            const j = await pub.json().catch(() => null);
            if (j?.url) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Video generated (${sizeMB} MB) for prompt: "${prompt}".\n\n**Watch it here:** ${j.url}\n\nThe link plays or downloads the MP4 directly.`,
                  },
                ],
              };
            }
          } else {
            logErr('publish', new Error(`publish HTTP ${pub.status}`));
          }
        } catch (e) {
          logErr('publish', e);
        }
      }
      // Fallback: inline base64 payload.
      return {
        content: [
          { type: 'text', text: `MP4 generated (${sizeMB} MB). base64 follows.` },
          { type: 'text', text: `data:video/mp4;base64,${vid.b64}` },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Video generation failed: ${e?.message || e}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[loop-media] MCP server ready');

/**
 * Express 4 does not catch rejections from async route handlers. This module
 * wraps async handlers at registration time. Import it before any router is
 * created (CommonJS evaluates imports in source order).
 */
import express from 'express'
import { asyncHandler } from './errorLogger'

type RouterMethod = (...args: unknown[]) => unknown

function isAsyncHandler(fn: unknown): fn is (...args: unknown[]) => unknown {
  return typeof fn === 'function' && fn.constructor?.name === 'AsyncFunction' && fn.length < 4
}

// Express stores VERB methods on the Router function itself. Each router
// instance uses that function as its prototype (setPrototypeOf), so
// Router.prototype is the wrong object to patch.
const routerApi = express.Router as unknown as Record<string, RouterMethod & { __loopWrapped?: boolean }>

for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const) {
  const original = routerApi[method]
  if (!original || original.__loopWrapped) continue
  const wrapped = function (this: unknown, ...args: unknown[]) {
    return original.call(this, ...args.map((arg) => (isAsyncHandler(arg) ? asyncHandler(arg as Parameters<typeof asyncHandler>[0]) : arg)))
  }
  wrapped.__loopWrapped = true
  routerApi[method] = wrapped
}

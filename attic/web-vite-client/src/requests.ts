// Cancelling invalidates callbacks synchronously, even if a transport resolves late.
export class Requests {
  private controllers = new Set<AbortController>()
  start(timeoutMs = 30_000) {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs)
    const finish = () => { clearTimeout(timer); this.controllers.delete(controller) }
    controller.signal.addEventListener('abort', finish, { once: true })
    return {
      signal: controller.signal,
      current: () => this.controllers.has(controller) && !controller.signal.aborted,
      abort: () => controller.abort(),
      finish,
    }
  }
  cancelAll() {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }
}

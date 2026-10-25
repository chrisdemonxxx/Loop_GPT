/** Reload once when a newer app shell takes control of this tab. A first
 *  visit has no controller yet, so it does not reload. */
export function watchShellUpdate(
  sw: { controller: ServiceWorker | null; addEventListener: (type: 'controllerchange', listener: () => void) => void },
  reload: () => void,
): void {
  if (!sw.controller) return
  let reloaded = false
  sw.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    reload()
  })
}

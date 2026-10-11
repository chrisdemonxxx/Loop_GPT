/**
 * End-to-end verification of the loop-gnome-desktop template:
 * boots a sandbox, lets the SDK do its XFCE-shim start, swaps to GNOME,
 * then proves GNOME owns the display (processes + a real screenshot).
 *
 * Run from backend/ so node resolves @e2b/desktop:
 *   node ../infra/e2b-gnome-desktop/verify.mjs
 */
const TEMPLATE = process.env.E2B_DESKTOP_TEMPLATE || 'loop-gnome-desktop'

async function main() {
  const { Sandbox } = await import('@e2b/desktop')
  console.log('[verify] creating sandbox with template', TEMPLATE)
  const sandbox = await Sandbox.create({ template: TEMPLATE, timeoutMs: 20 * 60_000 })
  const id = String(sandbox.sandboxId)
  console.log('[verify] sandbox up:', id)

  try {
    // Install GNOME into the live box if absent — the same path
    // botBox.ensureGnomeInstalled takes. (The template-time install was
    // pruned by E2B's optimize/snapshot phase three rebuilds running.)
    const present = await sandbox.commands.run('test -x /usr/bin/gnome-shell -a -x /usr/bin/gnome-session', { timeoutMs: 10_000 }).catch(() => null)
    if (!present || (present.exitCode ?? 1) !== 0) {
      console.log('[verify] installing GNOME into the live box (first boot, ~2-4 min)…')
      const install = await sandbox.commands.run(
        'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y gnome-session gnome-shell mutter gnome-terminal nautilus gnome-backgrounds adwaita-icon-theme-full gnome-themes-extra dbus-x11 mesa-utils libgl1-mesa-dri',
        { timeoutMs: 480_000 },
      )
      if ((install.exitCode ?? 1) !== 0) {
        console.error('[verify] GNOME install failed:\n' + install.stdout.slice(-2000) + install.stderr.slice(-1000))
        process.exitCode = 1
        return
      }
      console.log('[verify] GNOME installed')
    }

    // Swap to GNOME — same steps as botBox.swapToGnomeSession, inlined so
    // this harness has no dependency on backend build artifacts.
    const swap = [
      'mkdir -p /home/user/.config/autostart',
      `printf '[Desktop Entry]\\nType=Application\\nName=Loop GNOME settings\\nExec=sh -c "gsettings set org.gnome.desktop.session idle-delay 0; gsettings set org.gnome.desktop.screensaver lock-enabled false"\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/loop-gnome-settings.desktop`,
      'chown -R user:user /home/user/.config 2>/dev/null || true',
      'pkill -f xfce4-session 2>/dev/null; pkill -x xfwm4 2>/dev/null; pkill -x xfdesktop 2>/dev/null; true',
      'sleep 1',
      'cd /home/user && sudo -u user DISPLAY=:0 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=GNOME LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe /usr/bin/dbus-run-session -- /usr/bin/gnome-session --session=gnome > /tmp/gnome-session.log 2>&1 &',
    ].join(' && ')
    const handle = await sandbox.commands.run(swap, { background: true, timeoutMs: 0 })
    await handle.disconnect?.().catch(() => undefined)

    // gnome-shell alone proves the desktop: in nested X11 mode mutter is a
    // library inside the shell process, never a separate process.
    let gnome = false
    for (let i = 0; i < 20 && !gnome; i += 1) {
      try {
        const r = await sandbox.commands.run('pgrep -x gnome-shell >/dev/null', { timeoutMs: 5_000 })
        gnome = (r.exitCode ?? 1) === 0
      } catch { /* keep waiting */ }
      if (!gnome) await new Promise((r) => setTimeout(r, 1000))
    }
    if (!gnome) {
      console.log('[verify] gnome-session did not come up; starting nested gnome-shell directly')
      const h2 = await sandbox.commands.run(
        'cd /home/user && sudo -u user DISPLAY=:0 XDG_CURRENT_DESKTOP=GNOME LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe /usr/bin/gnome-shell --x11 --replace > /tmp/gnome-shell.log 2>&1 &',
        { background: true, timeoutMs: 0 },
      )
      await h2.disconnect?.().catch(() => undefined)
      for (let i = 0; i < 45 && !gnome; i += 1) {
        try {
          const r = await sandbox.commands.run('pgrep -x gnome-shell >/dev/null', { timeoutMs: 5_000 })
          gnome = (r.exitCode ?? 1) === 0
        } catch { /* keep waiting */ }
        if (!gnome) await new Promise((r) => setTimeout(r, 1000))
      }
    }

    const procs = await sandbox.commands.run("ps -eo comm | grep -E '^(gnome-shell|mutter|gnome-terminal|xfce4-session|xfwm4|xfdesktop)$' | sort -u", { timeoutMs: 10_000 })
    console.log('[verify] desktop processes:\n' + procs.stdout)

    if (!gnome) {
      const log1 = await sandbox.commands.run('tail -n 40 /tmp/gnome-session.log 2>/dev/null; tail -n 20 /tmp/gnome-shell.log 2>/dev/null', { timeoutMs: 10_000 })
      console.error('[verify] GNOME did not start. Session logs:\n' + log1.stdout)
      process.exitCode = 1
      return
    }
    console.log('[verify] GNOME session is running')

    const png = await sandbox.screenshot('bytes')
    const fs = await import('node:fs')
    const out = process.env.VERIFY_SCREENSHOT || `${process.env.TEMP || '/tmp'}\\gnome-verify.png`
    fs.writeFileSync(out, Buffer.from(png))
    console.log('[verify] screenshot written to', out, `(${png.length} bytes)`)

    const stream = await (async () => {
      try { await sandbox.stream.start({ requireAuth: true }) } catch (e) { if (!/already running/i.test(String(e?.message || e))) throw e }
      return sandbox.stream.getAuthKey()
    })()
    console.log('[verify] stream auth key present:', !!stream)
  } finally {
    await sandbox.kill().catch(() => undefined)
    console.log('[verify] sandbox killed')
  }
}

main().catch((error) => { console.error('[verify] failed:', error); process.exitCode = 1 })

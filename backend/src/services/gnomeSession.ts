/**
 * Swap the @e2b/desktop XFCE shim for a real GNOME session.
 *
 * The SDK's create() always starts XFCE (hardcoded). Our GNOME template bakes
 * gnome-shell / gnome-session into the image; this module kills the shim and
 * starts GNOME before any Computer UI is returned. No runtime apt.
 */

type Sandbox = {
  commands: {
    run: (
      cmd: string,
      opts?: { timeoutMs?: number; background?: boolean },
    ) => Promise<{ exitCode?: number | null; stdout?: string; stderr?: string; disconnect?: () => Promise<void> }>
  }
}

async function runQuiet(sandbox: Sandbox, cmd: string, timeoutMs = 25_000): Promise<void> {
  try {
    await sandbox.commands.run(cmd, { timeoutMs })
  } catch {
    /* best-effort setup steps */
  }
}

async function gnomeBinariesPresent(sandbox: Sandbox): Promise<boolean> {
  try {
    const present = await sandbox.commands.run(
      'test -x /usr/bin/gnome-shell -a -x /usr/bin/gnome-session',
      { timeoutMs: 10_000 },
    )
    return (present.exitCode ?? 1) === 0
  } catch (err: any) {
    // E2B throws CommandExitError on nonzero exit — treat as "not present".
    const code = err?.result?.exitCode ?? err?.exitCode
    if (code === 1 || code === '1') return false
    // Unexpected failures (network, auth): surface as missing so wake fails loud.
    return false
  }
}

async function gnomeShellRunning(sandbox: Sandbox): Promise<boolean> {
  try {
    const r = await sandbox.commands.run('pgrep -x gnome-shell >/dev/null', { timeoutMs: 5_000 })
    return (r.exitCode ?? 1) === 0
  } catch {
    return false
  }
}

/**
 * Block until GNOME owns DISPLAY=:0, or throw.
 * Callers must not return Computer / stream URLs until this resolves.
 */
export async function awaitGnomeDesktop(
  sandbox: Sandbox,
  options?: { resumeSnapshot?: boolean },
): Promise<void> {
  // A baseline snapshot was taken after GNOME was already up. Killing XFCE
  // and starting a second session on that disk is what left Reset asleep.
  if (options?.resumeSnapshot) {
    for (let i = 0; i < 20; i += 1) {
      if (await gnomeShellRunning(sandbox)) {
        console.info('[gnome-session] resumed snapshot already has GNOME')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(
      'The saved desktop did not resume. Reset left that snapshot alone instead of starting a second GNOME session.',
    )
  }

  const marker = '/tmp/.loop-gnome-session'
  try {
    const already = await sandbox.commands.run(`test -f ${marker}`, { timeoutMs: 5_000 }).catch(() => null)
    if (already && (already.exitCode ?? 1) === 0 && (await gnomeShellRunning(sandbox))) {
      return
    }
  } catch {
    /* proceed with swap */
  }

  if (!(await gnomeBinariesPresent(sandbox))) {
    throw new Error(
      'GNOME desktop is not installed in this sandbox template. Set E2B_DESKTOP_TEMPLATE to the loop-gnome-desktop image (see infra/e2b-gnome-desktop).',
    )
  }

  await runQuiet(
    sandbox,
    [
      'mkdir -p /home/user/.config/autostart',
      `printf '[Desktop Entry]\\nType=Application\\nName=Loop GNOME settings\\nExec=sh -c "gsettings set org.gnome.desktop.session idle-delay 0; gsettings set org.gnome.desktop.screensaver lock-enabled false"\\nX-GNOME-Autostart-enabled=true\\n' > /home/user/.config/autostart/loop-gnome-settings.desktop`,
      'chown -R user:user /home/user/.config 2>/dev/null || true',
    ].join(' && '),
  )

  const swap = [
    'pkill -f xfce4-session 2>/dev/null; pkill -x xfwm4 2>/dev/null; pkill -x xfdesktop 2>/dev/null; true',
    'sleep 1',
    'cd /home/user && sudo -u user DISPLAY=:0 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=GNOME LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe /usr/bin/dbus-run-session -- /usr/bin/gnome-session --session=gnome > /tmp/gnome-session.log 2>&1 &',
    `touch ${marker}`,
  ].join('; ')

  try {
    const handle = await sandbox.commands.run(swap, { background: true, timeoutMs: 0 })
    await handle.disconnect?.().catch(() => undefined)
  } catch {
    /* wait loops below report failure */
  }

  for (let i = 0; i < 20; i += 1) {
    if (await gnomeShellRunning(sandbox)) {
      console.info('[gnome-session] GNOME session owns the display')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  try {
    const handle = await sandbox.commands.run(
      'cd /home/user && sudo -u user DISPLAY=:0 XDG_CURRENT_DESKTOP=GNOME LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe /usr/bin/gnome-shell --x11 --replace > /tmp/gnome-shell.log 2>&1 &',
      { background: true, timeoutMs: 0 },
    )
    await handle.disconnect?.().catch(() => undefined)
  } catch {
    /* next wait reports */
  }

  for (let i = 0; i < 45; i += 1) {
    if (await gnomeShellRunning(sandbox)) {
      console.info('[gnome-session] GNOME shell owns the display (nested mode)')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  throw new Error(
    'GNOME session failed to start after XFCE shim swap — Computer will not return an XFCE-first paint. Check /tmp/gnome-session.log and /tmp/gnome-shell.log in the sandbox.',
  )
}

/** Desktop launchers seeded on every cold boot (Chrome + terminal). Idempotent. */
export async function seedDesktopLaunchers(sandbox: Sandbox): Promise<void> {
  const cmds = [
    'mkdir -p /home/user/Desktop /home/user/.local/share/applications',
    // Chrome launcher (prefer the template-shipped desktop file when present)
    `[ -f /usr/share/applications/google-chrome.desktop ] && cp -n /usr/share/applications/google-chrome.desktop /home/user/Desktop/google-chrome.desktop || printf '[Desktop Entry]\\nType=Application\\nName=Google Chrome\\nExec=google-chrome --start-maximized\\nIcon=google-chrome\\nTerminal=false\\nCategories=Network;WebBrowser;\\n' > /home/user/Desktop/google-chrome.desktop`,
    `printf '[Desktop Entry]\\nType=Application\\nName=Terminal\\nExec=x-terminal-emulator --working-directory=/workspace\\nIcon=utilities-terminal\\nTerminal=false\\nCategories=System;TerminalEmulator;\\n' > /home/user/Desktop/terminal.desktop`,
    'chmod +x /home/user/Desktop/*.desktop 2>/dev/null || true',
    'chown -R user:user /home/user/Desktop 2>/dev/null || true',
  ]
  await runQuiet(sandbox, cmds.join(' && '))
}

/** Template id used for persistent boxes and dedicated desktop VMs. */
export function desktopTemplateId(): string | undefined {
  const id = (process.env.E2B_DESKTOP_TEMPLATE || process.env.BOT_E2B_TEMPLATE || '').trim()
  return id || undefined
}

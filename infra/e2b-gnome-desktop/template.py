"""Loop GPT GNOME desktop template for E2B.

Forked from e2b-dev/desktop (their XFCE recipe). The @e2b/desktop SDK's
session bootstrap is hardcoded to `startxfce4` and verifies the XFCE session
processes at create() time, so the image keeps the three XFCE binaries the
SDK checks for — and nothing else from XFCE. GNOME packages are baked into
this template; botBox swaps to gnome-session immediately after the SDK's
create() returns. Everything the SDK does after that point (stream,
screenshots, input) is desktop-agnostic.
"""

from e2b import CopyItem, Template

template = (
    Template(file_context_path="files")
    .from_image("ubuntu:22.04")
    .set_user("root")
    .set_workdir("/")
    .set_envs(
        {
            "DEBIAN_FRONTEND": "noninteractive",
            "DEBIAN_PRIORITY": "high",
            "PIP_DEFAULT_TIMEOUT": "100",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_CACHE_DIR": "1",
        }
    )
    .run_cmd("yes | unminimize")
    .apt_install(
        [
            "xserver-xorg",
            "x11-xserver-utils",
            "xvfb",
            "x11-utils",
            "xauth",
            # SDK-compat shim: the @e2b/desktop client verifies these three
            # processes after startxfce4. They are killed right after boot
            # when the GNOME session takes over the display.
            "xfce4-session",
            "xfwm4",
            "xfdesktop4",
            "util-linux",
            "sudo",
            "curl",
            "git",
            "wget",
            "python3-pip",
            "xdotool",
            "scrot",
            "ffmpeg",
            "x11vnc",
            "net-tools",
            "netcat",
            "x11-apps",
            "xpdf",
            "galculator",
            "software-properties-common",
            "apt-transport-https",
            "libgtk-3-bin",
            # Real desktop: GNOME is baked into the template so first boot does
            # not apt-install for 2–4 minutes. The SDK still starts its XFCE
            # shim; botBox swaps to gnome-session immediately after create().
            "gnome-session",
            "gnome-shell",
            "mutter",
            "gnome-terminal",
            "nautilus",
            "gnome-backgrounds",
            "adwaita-icon-theme-full",
            "gnome-themes-extra",
            "dbus-x11",
            "mesa-utils",
            "libgl1-mesa-dri",
        ]
    )
    .apt_install(["libreoffice", "gedit"])
    .pip_install("numpy")
    # NoVNC and websockify — identical to the upstream recipe; the stream
    # path does not care which compositor owns the display.
    .git_clone(
        "https://github.com/e2b-dev/noVNC.git", "/opt/noVNC", branch="e2b-desktop"
    )
    .make_symlink("/opt/noVNC/vnc.html", "/opt/noVNC/index.html")
    .git_clone(
        "https://github.com/novnc/websockify.git",
        "/opt/noVNC/utils/websockify",
        branch="v0.12.0",
    )
    # Browsers and editor.
    .run_cmd(
        [
            "add-apt-repository ppa:mozillateam/ppa",
            "wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -",
            'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list',
            "wget -qO- https://packages.microsoft.com/keys/microsoft.asc | apt-key add -",
            'add-apt-repository -y "deb [arch=amd64] https://packages.microsoft.com/repos/vscode stable main"',
            "apt-get update",
        ],
    )
    .apt_install(["firefox-esr", "google-chrome-stable", "code"])
    # Seeded autostarts launch x-terminal-emulator; point it at gnome-terminal
    # (the .wrapper path is not always present on minimal images).
    .run_cmd(
        "update-alternatives --install /usr/bin/x-terminal-emulator x-terminal-emulator /usr/bin/gnome-terminal 50 && "
        "update-alternatives --set x-terminal-emulator /usr/bin/gnome-terminal"
    )
    .run_cmd("update-alternatives --set x-www-browser /usr/bin/google-chrome-stable")
    .make_dir("/home/user/.config/Code/User")
    .make_dir("/home/user/.config/autostart")
    .run_cmd("update-desktop-database /usr/share/applications/")
    .copy_items(
        [
            CopyItem(
                src="google-chrome.desktop",
                dest="/usr/share/applications/google-chrome.desktop",
            ),
            CopyItem(
                src="settings.json",
                dest="/home/user/.config/Code/User/settings.json",
            ),
            CopyItem(
                src="wallpaper.png",
                dest="/usr/share/backgrounds/wallpaper.png",
            ),
            CopyItem(
                src="screensaver.desktop",
                dest="/home/user/.config/autostart/screensaver.desktop",
            ),
            CopyItem(
                src="firefox-policies.json",
                dest="/usr/lib/firefox-esr/distribution/policies.json",
            ),
            CopyItem(
                src="firefox-autoconfig.js",
                dest="/usr/lib/firefox-esr/defaults/pref/autoconfig.js",
            ),
            CopyItem(src="firefox.cfg", dest="/usr/lib/firefox-esr/firefox.cfg"),
        ]
    )
)

template_with_user_workdir = template.set_user("user").set_workdir("/home/user")

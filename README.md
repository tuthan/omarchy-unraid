# Unraid

An Omarchy Quickshell plugin that monitors and manages an Unraid server from
the bar, over the native Unraid GraphQL API (Unraid 7.2+).

![Unraid plugin preview](preview.png)

# Video

https://github.com/user-attachments/assets/944ab549-4224-49f4-8716-c34aeb8b98aa

## Install

From the plugin repository:

```bash
omarchy plugin add https://github.com/tuthan/omarchy-unraid.git --enable
```

For local development:

```bash
plugin_dir="$HOME/.config/omarchy/plugins/io.github.hvo.omarchy-unraid"
mkdir -p "$(dirname "$plugin_dir")"
if [ -L "$plugin_dir" ]; then unlink "$plugin_dir"; fi
mkdir -p "$plugin_dir"
rsync -a --delete --exclude='.git/' "$PWD"/ "$plugin_dir"/
omarchy-shell shell rescanPlugins
omarchy plugin enable io.github.hvo.omarchy-unraid --section right
```

Omarchy expects a real plugin directory, so this setup copies the repository
into the plugin directory instead of symlinking it. The `.git` directory is
excluded because it is not needed by the runtime and may be protected by
Omarchy. After making source changes, rerun the `rsync` command and
`omarchy-shell shell rescanPlugins`, then `omarchy restart shell` if the bar
widget does not pick up the change.

The plugin requires `curl` for API calls.

## Update

For a plugin installed from GitHub, update it with:

```bash
omarchy plugin update io.github.hvo.omarchy-unraid --yes
omarchy restart shell
```

For local development, recopy the repository into the real plugin directory
and rescan it:

```bash
rsync -a --delete --exclude='.git/' "$PWD"/ "$HOME/.config/omarchy/plugins/io.github.hvo.omarchy-unraid"/
omarchy-shell shell rescanPlugins
```

## Setup

Open the panel and switch to the **Setup** tab:

- **Server URL** — base URL of the Unraid server, for example
  `http://tower.local` or `http://192.168.1.10`. The API is served at
  `/graphql` on the plain HTTP listener; the HTTPS listener rejects API keys
  on current Unraid builds.
- **API key** — create one under Unraid web UI → Settings → Management
  Access. The key needs read access; management actions additionally need
  write roles for Docker, VMs, array, and parity check.
- **Poll interval** — seconds between bar refreshes (default 30).
- **Management** — off by default. When enabled, start/stop actions become
  available for containers, VMs, the array, and parity checks. Destructive
  actions confirm inline: the button turns into `CONFIRM?` for four seconds;
  click again to fire.
- **Theme** — Unraid brand colors (orange accent) by default, or follow the
  Omarchy palette.

Settings are stored in `~/.config/omarchy/shell.json` under the widget's bar
entry and survive restarts.

## Panel tabs

- **Array** — per-disk usage bars, temperature, and status for data disks,
  cache pools, and parity; array start/stop and parity check
  start/pause/resume/cancel when management is enabled.
- **System** — CPU and memory usage history graphs with a per-core breakdown,
  uptime, parity check status (last run, duration, errors), hottest disk
  temperature, and a link to open the Unraid web dashboard.
- **Docker** — container list with state and autostart; start/stop/restart
  per container when management is enabled.
- **VMs** — virtual machine list with state; start/stop per VM when
  management is enabled.
- **Setup** — configuration as described above.

## Keyboard

- `1`–`5` switch tabs
- `←`/`→` cycle tabs
- `R` refresh
- `Esc` close

## Behavior

- The bar pill shows the Unraid mark with the number of running containers;
  an orange/red dot appears next to it when the array is degraded, containers
  are dead, or the API is unreachable. Hovering shows a one-line summary.
- History graphs accumulate one point per poll (up to 90 points) and survive
  panel open/close.
- Parity history and uptime are fetched on demand when the System or Array
  tab opens, not on every poll.
- `RESTART` on a container is emulated as a chained stop followed by start,
  because the restart mutation is not available on current Unraid API builds.
- Reboot/shutdown are not implemented: the Unraid GraphQL API does not expose
  them yet.
- With multiple monitors, each bar widget targets its own server connection
  and the panel opens anchored to the clicked widget.

## Remove

```bash
omarchy plugin remove io.github.hvo.omarchy-unraid
```

## License

MIT

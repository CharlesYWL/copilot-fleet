# Linux login startup

Start the Host and Node automatically on Linux with a **`systemd --user`**
service. It runs as your normal account, with your own GitHub, Copilot and Dev
Tunnels credentials. It is never installed as a system service or as root.

The command line is the same as on Windows (see
[Windows login startup](windows-login-startup.md)); only the service manager
underneath differs.

## Requirements

- A running systemd user manager. Check with `systemctl --user show-environment`.
  Most desktop and server distributions have one. **Plain WSL and containers
  usually do not.** On WSL, enable it in `/etc/wsl.conf`:

  ```ini
  [boot]
  systemd=true
  ```

  then run `wsl --shutdown` from Windows and reopen the distribution.
- Node.js, Git, GitHub CLI and Copilot CLI installed for your user, and Copilot
  signed in. Dev Tunnels Nodes also need `devtunnel user login`.
- A normal user account. The installer refuses to run as root.

Without a systemd user manager the installer stops with a message that points to
the launcher instead. `npm start` runs the Host and Node in the foreground with
the same self-update and restart behaviour; keep it running in `tmux`, `screen`
or a terminal you leave open.

## Install

Run these in an updated checkout, as the user that should own the service. Stop
any Host or Node you started by hand first.

```bash
# New Node: use the real values from the Host's Connect card.
npm run service -- node --devtunnel="<tunnel-id>" --host-id="<host-id>" --host-fingerprint="<sha256>" --enrollment-grant="<id.secret>"

# Already enrolled: choose Node-only or Host+Node.
npm run service -- node install --existing-node
npm run service -- host+node install --existing-node
```

The install options (`--existing-node`, `--no-build`, `--no-start`,
`--config-port`, `--url`, `--devtunnel`, Corp direct flags) and the GitHub CLI
credential check behave exactly as described for Windows.

Installation writes one unit per workload:

| Workload | Unit | Unit file |
| --- | --- | --- |
| Host | `copilot-fleet-host.service` | `~/.config/systemd/user/copilot-fleet-host.service` |
| Node | `copilot-fleet-node.service` | `~/.config/systemd/user/copilot-fleet-node.service` |

`$XDG_CONFIG_HOME` replaces `~/.config` when it is set. The unit runs
`scripts/login-service-runner.mjs <manifest>` from the checkout with the Node.js
binary that ran the installer. The manifest, `runtime.log` and the probe result
live under `~/.local/state/copilot-fleet/login/host` and `.../node`
(`$XDG_STATE_HOME` when set), readable only by you. The manifest records your
uid instead of a Windows SID, and a service is refused if its manifest belongs to
another user.

## Starting at boot

A user unit starts when you log in. To also start it at boot without a login,
enable lingering for your account:

```bash
sudo loginctl enable-linger "$USER"
```

The installer tries to enable lingering itself. When policy does not allow it,
installation still succeeds and prints the command above.

## Manage

```bash
npm run service -- host+node status
npm run service -- node logs
npm run service -- host+node stop
npm run service -- host+node start
npm run service -- host+node restart
npm run service -- node uninstall
```

As on Windows, **stop also disables** the unit, so it does not start at the next
login until `start` enables it again. Uninstall disables the unit and removes
only its unit file; the checkout, identity, database, settings, credentials and
logs are kept.

The usual systemd tools work too, for example
`systemctl --user status copilot-fleet-node` or
`journalctl --user -u copilot-fleet-node`. Application output goes to
`runtime.log` rather than the journal; use `npm run service -- node logs` for it.

## Restart and recovery

- **Crash:** the Node's login runner retries a failed supervisor up to four
  times (after 5, 15, 30 and 60 seconds), as on Windows. Before each retry it
  verifies that the previous attempt's process group is empty. If that cannot be
  proved, it stops instead of starting a second writer. The unit also has
  `Restart=on-failure`, which restarts the whole runner after a failure; a clean
  exit (0) does not restart it.
- **Stop:** the unit uses `KillMode=control-group`, so stopping it ends every
  process it started, including agents that run in their own process groups.
- **Node update:** the Node's supervisor turns the update exit (75) into a
  restart inside the same unit. systemd is not involved.

## Updating the Host from Settings

**Settings → General → Update Host** works for a service-managed Host. The Host
cannot restart its own unit from inside it, because stopping the unit ends
everything in it. It starts the updater as a **transient user unit** instead:

```text
systemd-run --user --unit=copilot-fleet-update-<id> --collect ...
```

That unit runs `scripts/self-update.mjs` outside both Fleet units: it fetches,
resets, runs `npm install --include=dev` and `npm run build`, then
`npm run service -- host+node restart` (or `host restart` when this checkout has
no Node unit, or its Node unit was stopped). `--collect` removes the transient unit when it finishes,
whether it succeeded or failed. A failed build restarts nothing. Output goes to
`self-update.log` and progress to `self-update.json` beside the Host database,
as on Windows. Inspect a running update with
`systemctl --user status copilot-fleet-update-<id>`.

The Host recognises that it was started by this service because its output is
the manifest's `runtime.log`. A Host started by hand, or by `npm start`, uses the
launcher's own update and restart path instead and never touches the units.

## Process ownership on Linux

Linux has no Windows Job Objects. Fleet uses process groups instead: each agent,
managed task and remote command runs as the leader of its own group, and Fleet
treats the group as empty only when `kill(-pgid, 0)` reports that no member is
left. A process that deliberately leaves its group with `setsid()` or
`setpgid()` escapes this tracking. The service's control group still ends it when
the unit stops. See
[Managed worktree isolation](managed-worktree-isolation.md) for the details.

macOS uses the same code paths but is not tested. It has no `systemd`, so use
`npm start` there.

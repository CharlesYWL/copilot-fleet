# Host MCP forwarding and Agency mode

[← README](../../README.md) · [Guide index](README.md)

Share Host-authenticated MCP servers with Nodes, and launch sessions through Agency.

## Host-authenticated MCP forwarding

Open **Settings → Security → Host MCP forwarding → Choose MCPs…**. The settings
card shows only enabled MCP names in a compact summary. The searchable dialog
contains a scrollable **Off / Share with all nodes** radio group for each MCP
configured in Copilot on the Host, so large catalogs do not fill the settings page. Selected
MCPs are shared with all enrolled Nodes, including Nodes added later. There is
no Node picker; unselected MCPs stay off. HTTP, SSE and local/stdio MCPs are
supported. Listing the catalog does not start the servers.

Sharing checks the selected server's connection before saving. For a newly
selected server, Fleet records its currently available tools and resources.
Turning it off retains those selections, so turning Figma back on does not
silently widen a curated read-only grant. New tools are not automatically added.
The UI never receives commands, arguments, environment values, headers or tokens.
Commands and credentials for local/stdio servers remain on the Host. The pinned
Host definition must still match when a new upstream connection is opened; if
it changes, turn forwarding off and on to check the new definition.

Changes are saved automatically and applied without restarting the Host.
Turning a server off immediately revokes its relay grants. New or resumed
sessions receive newly shared MCPs; an already-running ACP session may need
**Stop → Resume**. Saving a wider grant requires a recent Microsoft administrator
sign-in (or the local operator when sign-in is deliberately disabled).
Shared tools can access data or act using the Host account's permissions.

For OAuth-backed MCPs such as Figma, Fleet authenticates on the Host. This
avoids ACP connections which report "requires authentication" even after a
successful terminal login. The Host uses Copilot's SDK to activate its cached
OAuth connection and refresh credentials; it never prompts a model to relay a
tool call. OAuth credentials are never sent to Nodes.

On the Host, authenticate the MCP using Copilot's `/mcp auth figma` command as the
same OS user running the Host service. Settings are stored in `host-mcp.json`
beside the Host database (`apps/host/data/host-mcp.json` by default), or at
`FLEET_HOST_MCP_CONFIG`. For advanced, manually scoped configuration:

```json
{
  "servers": [
    {
      "name": "figma",
      "url": "https://mcp.figma.com/mcp",
      "readOnly": true,
      "resources": ["skill://figma/figma-design-to-code/SKILL.md"],
      "tools": [
        "whoami",
        "get_screenshot",
        "get_design_context",
        "get_metadata",
        "get_variable_defs"
      ],
      "allNodes": true,
      "nodeIds": [],
      "sessionIds": []
    }
  ]
}
```

Use actual Fleet UUIDs from **Session information** or the Nodes API.
`allNodes: true` is the Settings radio's normal scope. For manually restricted
grants, omit it and use `nodeIds` or `sessionIds`; the UI labels those as
**Limited scope** until you choose all nodes. Exact tool allowlists are still
required; there are no wildcard tools. This is operator configuration, not a
way for an agent to grant itself access. Protect the file as Host
configuration. Missing files leave forwarding off; malformed files fail startup.

Restart the Host after **manually** editing the file. UI changes need no restart.
New sessions and Fleet **Resume**
receive the relay as **`fleet-host-figma`** (generally `fleet-host-<name>`).
Use those Host-authenticated tools instead of the Node-local `figma` connection.
The distinct name is essential: Copilot's local MCP configuration takes precedence
over an ACP-injected server with the same name. Node-local configuration is not
modified or silently replaced.
Already-running ACP processes retain their original MCP configuration: stop
and resume an idle session through Fleet to switch it. No Node upgrade is needed.
Read-only Fleet sessions receive only configurations explicitly marked
`"readOnly": true`. Set this only when **every selected tool is read-only**: it is
the Host operator's declaration, not automatic detection or a sandbox. With the
default `false`, the relay is restricted to ordinary writing sessions. Worker
read-only policies are never changed to gain MCP access.
`GET /api/host-mcp` lists the configured grants behind normal operator sign-in.

The relay uses the Node's existing HTTPS (or local-forward) route to the Host;
no additional public port or Figma token distribution is needed. Its separate
signed capability is bound to the session, Node, task and exact configuration.
Stopping/cleaning up a session, completing its task, disconnecting its Node, or
removing its scope revokes access. Disabling/re-enabling issues a new grant
generation; old tokens cannot be resurrected by toggling a server back on.
Browser requests, plaintext external endpoints and unapproved tools are refused.
MCP text, images, resource links and structured results are preserved, including
short-lived Figma screenshot asset URLs. Tool calls are bounded and never
automatically replayed after failure.

`resources` is an optional exact URI allowlist. For Figma, include the
design-to-code guidance shown above: `get_design_context` requires it. The relay
supports standard MCP resource listing/reading and exposes a `read_resource` tool
for ACP clients without resource controls. Use
`fleet-host-figma.read_resource` to load that guidance before design retrieval.
Resource templates, arbitrary URIs and Host filesystem reads are not exposed.
Human-review/approval holds revoke relay access as well as completed tasks.

Host MCP configuration and OAuth credentials are not included in portable
backups. A restore suspends forwarding in the running Host; review the local
configuration and restart before re-enabling it. Authenticate again on the Host
if a relay reports an OAuth error; authenticating on the worker cannot repair the
Host's connection.

## Agency mode

Enable **Settings → General → Agency mode** to prefer
[Agency Copilot](https://aka.ms/agency) across the fleet. It is off by default.
The setting is marked **Staff** and is only shown to Microsoft employees signed
in with an `@microsoft.com` account in Microsoft's corporate tenant. Other
accounts and password-only logins cannot see or change it.
Update the Fleet Host and Nodes to a version with this setting before using it.

Each Node looks for `agency` on its own `PATH` and launches
`agency copilot --acp --stdio` instead of plain `copilot`. This applies to new
and resumed Copilot sessions, including Chats, Copilot orchestrators, workers, adopted
conversations, and automatic recovery. Existing running sessions are left alone;
stop and resume them to switch launchers. Turning the setting off uses standard
Copilot again on the next launch.

Install Agency and run `agency copilot` interactively as the same user that runs
the Node; use `/login` if prompted, and configure the MCP servers you need in
Agency. Restart the Node after changing its `PATH`. Fleet uses that Node's Agency
configuration rather than copying credentials or MCP configuration from the Host.
Enabling this setting does not automatically enable every Agency MCP server or
grant access to internal services.

Large MCP catalogs can exceed a small model's context budget. If Copilot reports
that its static instructions or tool definitions do not fit, select a
larger-context model; Fleet does not silently override your model choice.

If Agency is absent from a Node's `PATH`, that Node falls back to its configured
Copilot command (`FLEET_COPILOT_COMMAND`, or `copilot`) and records the fallback in
the session log. A broken or unauthenticated Agency installation reports an error
instead of silently switching providers. The existing minimum Copilot version,
YOLO permissions, model/context choices, and Fleet orchestration MCP tools still
apply. Agency mode is saved with the Host and included in Host backups.

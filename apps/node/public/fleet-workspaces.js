import { $, el, note, post } from "./ui.js";

export const initFleetWorkspaces = () => {
  let workspaces = [];
  let placements = [];
  let fleetLoadError = "";

  const workspaceItem = (workspace) =>
    el("div", { className: "item" }, [
      el("div", { className: "ws-name", textContent: workspace.name }),
      el("div", { className: "row" }, [
        el("input", {
          value: workspace.name,
          maxLength: 100,
          dataset: { ws: workspace.id },
        }),
        el("button", {
          type: "button",
          textContent: "Rename",
          dataset: { wsSave: workspace.id },
        }),
      ]),
    ]);

  const placementItem = (placement) =>
    el("div", { className: "item" }, [
      el("div", {
        className: "ws-name",
        textContent: placement.workspaceName || placement.workspaceId,
      }),
      el("div", { className: "row" }, [
        el("input", {
          value: placement.localPath,
          dataset: { pl: placement.id },
        }),
        el("button", {
          type: "button",
          textContent: "Browse…",
          dataset: { plBrowse: placement.id },
        }),
        el("button", {
          type: "button",
          textContent: "Save",
          dataset: { plSave: placement.id },
        }),
      ]),
      el("div", { className: "check", dataset: { check: placement.id } }),
    ]);

  const replaceChildren = (id, nodes, emptyText) => {
    $(id).replaceChildren(
      ...(nodes.length
        ? nodes
        : [el("p", { className: "empty", textContent: emptyText })]),
    );
  };

  const renderFleet = () => {
    replaceChildren("workspaces", workspaces.map(workspaceItem), "No workspaces yet.");
    replaceChildren(
      "placements",
      placements.map(placementItem),
      "This machine has no placement yet.",
    );

    const select = $("plWorkspace");
    const keep = select.value;
    select.replaceChildren(
      el("option", { value: "", textContent: "Select a workspace" }),
      ...workspaces.map((workspace) =>
        el("option", { value: workspace.id, textContent: workspace.name }),
      ),
    );
    select.value = keep;

    const sessionPlacement = $("newSessionPlacement");
    const selectedPlacement = sessionPlacement.value;
    sessionPlacement.replaceChildren(
      el("option", { value: "", textContent: "Select a placement" }),
      ...placements.map((placement) =>
        el("option", {
          value: placement.id,
          textContent: placement.workspaceName || placement.workspaceId,
        }),
      ),
    );
    sessionPlacement.value = selectedPlacement;
    sessionPlacement.dataset.unavailableReason = placements.length
      ? ""
      : fleetLoadError || "Create a placement on this machine before starting a session.";
    if ($("newSessionDialog").open) {
      note(
        "newSessionMsg",
        sessionPlacement.dataset.unavailableReason,
        Boolean(placements.length),
      );
    }
  };

  const loadFleet = async () => {
    try {
      const response = await fetch("/api/fleet");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not reach the Host");
      workspaces = data.workspaces;
      placements = data.placements;
      fleetLoadError = "";
      renderFleet();
      note("wsMsg", "", true);
    } catch (error) {
      workspaces = [];
      placements = [];
      fleetLoadError = error.message;
      renderFleet();
      note("wsMsg", error.message, false);
    }
  };

  const checkPath = async (path, target) => {
    if (!path.trim()) {
      target.className = "check";
      target.textContent = "";
      return false;
    }
    const result = await post("/api/check-path", { path });
    target.className = "check " + (result.ok ? "ok" : "err");
    target.textContent = result.ok ? "Folder found on this machine" : result.reason;
    return result.ok;
  };

  const openPicker = async (targetInput, button, check) => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Waiting…";
    try {
      const result = await post("/api/pick-folder", {
        path: targetInput.value.trim(),
      });
      if (result.ok) {
        targetInput.value = result.path;
        await checkPath(result.path, check);
      } else if (!result.canceled) {
        note("plMsg", result.reason, false);
      }
    } catch (error) {
      note("plMsg", error.message, false);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  $("wsAdd").addEventListener("click", async () => {
    const name = $("wsName").value.trim();
    if (!name) return;
    try {
      await post("/api/workspaces", { name, description: "" });
      $("wsName").value = "";
      await loadFleet();
      note("wsMsg", "Workspace created.", true);
    } catch (error) {
      note("wsMsg", error.message, false);
    }
  });

  $("workspaces").addEventListener("click", async (event) => {
    const id = event.target.dataset ? event.target.dataset.wsSave : undefined;
    if (!id) return;
    const input = document.querySelector('[data-ws="' + id + '"]');
    try {
      await post("/api/workspaces", {
        id,
        name: input.value.trim(),
        description: "",
      });
      await loadFleet();
      note("wsMsg", "Workspace renamed.", true);
    } catch (error) {
      note("wsMsg", error.message, false);
    }
  });

  $("placements").addEventListener("input", async (event) => {
    const id = event.target.dataset ? event.target.dataset.pl : undefined;
    if (!id) return;
    await checkPath(
      event.target.value,
      document.querySelector('[data-check="' + id + '"]'),
    );
  });

  $("placements").addEventListener("click", async (event) => {
    const id = event.target.dataset ? event.target.dataset.plSave : undefined;
    if (!id) return;
    const input = document.querySelector('[data-pl="' + id + '"]');
    try {
      await post("/api/placements", { id, localPath: input.value.trim() });
      await loadFleet();
      note("plMsg", "Path updated.", true);
    } catch (error) {
      note("plMsg", error.message, false);
    }
  });

  $("plPath").addEventListener("input", async (event) => {
    await checkPath(event.target.value, $("plCheck"));
  });

  $("plAdd").addEventListener("click", async () => {
    const workspaceId = $("plWorkspace").value;
    const localPath = $("plPath").value.trim();
    if (!workspaceId) {
      note("plMsg", "Pick a workspace first.", false);
      return;
    }
    try {
      await post("/api/placements", { workspaceId, localPath });
      $("plPath").value = "";
      $("plCheck").textContent = "";
      await loadFleet();
      note("plMsg", "Placement added.", true);
    } catch (error) {
      note("plMsg", error.message, false);
    }
  });

  $("plBrowse").addEventListener("click", (event) => {
    void openPicker($("plPath"), event.target, $("plCheck"));
  });

  $("placements").addEventListener("click", (event) => {
    const id = event.target.dataset ? event.target.dataset.plBrowse : undefined;
    if (!id) return;
    void openPicker(
      document.querySelector('[data-pl="' + id + '"]'),
      event.target,
      document.querySelector('[data-check="' + id + '"]'),
    );
  });

  void loadFleet();
};

import { $, el, note, post, showPanel } from "./ui.js";

export const initSessions = () => {
  let sessions = [];
  let selectedSessionId = "";
  let nextSessionCursor = "";
  let sessionFilter = "all";
  let sessionLoading = false;
  let previewRequest;
  let previewedSessionId = "";
  const resumedSessionIds = new Set();

  const formatDate = (value) => {
    if (!value) return "Unavailable";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "Unavailable" : date.toLocaleString();
  };

  const timeGroup = (value) => {
    if (!value) return "Older";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return "Older";
    const age = Date.now() - date.valueOf();
    if (age < 24 * 60 * 60 * 1000) return "Today";
    if (age < 7 * 24 * 60 * 60 * 1000) return "This week";
    if (age < 30 * 24 * 60 * 60 * 1000) return "This month";
    return "Older";
  };

  const visibleSessions = () => {
    const query = $("sessionSearch").value.trim().toLocaleLowerCase();
    return sessions
      .filter((session) => {
        if (sessionFilter === "resumable" && !session.resumable) return false;
        if (sessionFilter === "legacy" && !session.legacy) return false;
        if (!query) return true;
        return [session.title, session.workspaceName]
          .filter(Boolean)
          .some((value) => value.toLocaleLowerCase().includes(query));
      })
      .sort((left, right) => {
        const leftAt = Date.parse(left.updatedAt || "") || 0;
        const rightAt = Date.parse(right.updatedAt || "") || 0;
        return rightAt - leftAt || left.id.localeCompare(right.id);
      });
  };

  const sessionRow = (session) =>
    el(
      "button",
      {
        type: "button",
        className: "session-item" + (session.id === selectedSessionId ? " selected" : ""),
        dataset: { sessionId: session.id },
        ariaLabel: `${session.title || "Untitled session"}, ${
          session.workspaceName || "project unavailable"
        }`,
      },
      [
        el("span", {
          className: "session-item-title",
          textContent: session.title || "Untitled session",
        }),
        el("span", {
          className: "session-item-meta",
          textContent:
            (session.workspaceName || "Project unavailable") +
            " · " +
            (session.updatedAt ? formatDate(session.updatedAt) : "Time unavailable"),
        }),
      ],
    );

  const renderSessions = () => {
    const list = $("sessionList");
    const visible = visibleSessions();
    if (!visible.length) {
      list.replaceChildren(
        el("div", {
          className: "empty",
          textContent: sessions.length
            ? "No sessions match this search."
            : "No Copilot sessions were found for this user.",
        }),
      );
      return;
    }
    const nodes = [];
    let group = "";
    for (const session of visible) {
      const nextGroup = timeGroup(session.updatedAt);
      if (nextGroup !== group) {
        group = nextGroup;
        nodes.push(el("div", { className: "session-group", textContent: group }));
      }
      nodes.push(sessionRow(session));
    }
    list.replaceChildren(...nodes);
  };

  const selectedSession = () =>
    sessions.find((session) => session.id === selectedSessionId);

  const renderSelectedSession = () => {
    const session = selectedSession();
    $("sessionEmpty").classList.toggle("hidden", Boolean(session));
    $("sessionDetail").classList.toggle("hidden", !session);
    if (!session) return;

    $("sessionProject").textContent = session.workspaceName || "Project unavailable";
    $("sessionDetailTitle").textContent = session.title || "Untitled session";
    $("sessionStatus").textContent = session.status || "Available";
    $("sessionUpdated").textContent = formatDate(session.updatedAt);
    $("sessionCreated").textContent = formatDate(session.createdAt);
    $("sessionStableId").textContent = session.id;
    const resume = $("resumeSession");
    const alreadyResumed = resumedSessionIds.has(session.id);
    resume.disabled = !session.resumable || alreadyResumed;
    resume.textContent = alreadyResumed ? "Resumed" : "Resume";
    note(
      "resumeNotice",
      session.resumable
        ? session.legacy
          ? "This older session has limited metadata, but Copilot reports that its context can be loaded."
          : ""
        : session.resumeReason || "This session cannot be resumed.",
      session.resumable,
    );
    if (previewedSessionId !== session.id) {
      $("loadPreview").disabled = false;
      $("sessionPreview").className = "preview empty";
      $("sessionPreview").textContent =
        "Select “Load preview” to inspect recent conversation context.";
    }
  };

  const selectSession = (id) => {
    if (id === selectedSessionId) return;
    selectedSessionId = id;
    previewedSessionId = "";
    previewRequest?.abort();
    renderSessions();
    renderSelectedSession();
    showPanel("sessionPanel");
  };

  const loadSessions = async ({ append = false } = {}) => {
    if (sessionLoading) return;
    sessionLoading = true;
    $("sessionRefresh").disabled = true;
    if (!append) {
      $("sessionList").replaceChildren(
        el("div", { className: "skeleton-list", ariaLabel: "Loading sessions" }, [
          el("span"),
          el("span"),
          el("span"),
        ]),
      );
    }
    try {
      const suffix =
        append && nextSessionCursor
          ? "?cursor=" + encodeURIComponent(nextSessionCursor)
          : "";
      const response = await fetch("/api/sessions" + suffix);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not discover sessions");
      const incoming = Array.isArray(data.sessions) ? data.sessions : [];
      const byId = new Map(
        (append ? sessions : []).map((session) => [session.id, session]),
      );
      for (const session of incoming) byId.set(session.id, session);
      sessions = [...byId.values()];
      nextSessionCursor = data.nextCursor || "";
      $("sessionMore").classList.toggle("hidden", !nextSessionCursor);
      if (selectedSessionId && !byId.has(selectedSessionId)) selectedSessionId = "";
      renderSessions();
      renderSelectedSession();
    } catch (error) {
      $("sessionList").replaceChildren(
        el("div", { className: "msg err", textContent: error.message }),
      );
    } finally {
      sessionLoading = false;
      $("sessionRefresh").disabled = false;
    }
  };

  $("sessionList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-session-id]");
    if (row) selectSession(row.dataset.sessionId);
  });

  $("sessionList").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...$("sessionList").querySelectorAll("[data-session-id]")];
    const index = rows.indexOf(event.target.closest("[data-session-id]"));
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  });

  $("sessionSearch").addEventListener("input", renderSessions);
  $("sessionRefresh").addEventListener("click", () => void loadSessions());
  $("sessionMore").addEventListener("click", () => void loadSessions({ append: true }));

  for (const filter of document.querySelectorAll("[data-session-filter]")) {
    filter.addEventListener("click", () => {
      sessionFilter = filter.dataset.sessionFilter;
      for (const item of document.querySelectorAll("[data-session-filter]")) {
        item.classList.toggle("active", item === filter);
      }
      renderSessions();
    });
  }

  $("loadPreview").addEventListener("click", async () => {
    const session = selectedSession();
    if (!session) return;
    previewRequest?.abort();
    previewRequest = new AbortController();
    const requestedId = session.id;
    const view = $("sessionPreview");
    $("loadPreview").disabled = true;
    view.className = "preview empty";
    view.textContent = "Loading supported context…";
    try {
      const response = await fetch(
        "/api/sessions/" + encodeURIComponent(requestedId) + "/preview",
        { signal: previewRequest.signal },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load session context");
      if (selectedSessionId !== requestedId) return;
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        previewedSessionId = requestedId;
        view.className = "preview empty";
        view.textContent =
          "Copilot loaded this session, but no text preview is available.";
        return;
      }
      previewedSessionId = requestedId;
      view.className = "preview";
      view.replaceChildren(
        ...items.map((item) =>
          el("div", { className: "preview-message" }, [
            el("div", {
              className: "preview-role",
              textContent: item.role === "user" ? "You" : "Copilot",
            }),
            el("p", { className: "preview-text", textContent: item.text }),
          ]),
        ),
        ...(data.truncated
          ? [
              el("div", {
                className: "hint",
                textContent:
                  "Preview shortened. Full context remains available on resume.",
              }),
            ]
          : []),
      );
    } catch (error) {
      if (error.name === "AbortError") return;
      view.className = "preview";
      view.replaceChildren(
        el("div", { className: "msg err", textContent: error.message }),
      );
    } finally {
      if (selectedSessionId === requestedId) $("loadPreview").disabled = false;
    }
  });

  $("resumeSession").addEventListener("click", async () => {
    const session = selectedSession();
    if (!session || !session.resumable || resumedSessionIds.has(session.id)) return;
    const button = $("resumeSession");
    button.disabled = true;
    button.textContent = "Resuming…";
    note("resumeNotice", "Loading this session’s supported Copilot context…", true);
    try {
      const result = await post(
        "/api/sessions/" + encodeURIComponent(session.id) + "/resume",
        {},
      );
      resumedSessionIds.add(session.id);
      session.status = result.state || "starting";
      renderSessions();
      renderSelectedSession();
      note(
        "resumeNotice",
        "Resume started. The session is now available in the Fleet Host.",
        true,
      );
    } catch (error) {
      note("resumeNotice", error.message, false);
      button.disabled = false;
      button.textContent = "Resume";
    }
  });

  const newSessionDialog = $("newSessionDialog");
  const closeNewSession = () => {
    newSessionDialog.close();
    note("newSessionMsg", "", true);
  };

  $("newSession").addEventListener("click", () => {
    newSessionDialog.showModal();
    const unavailableReason = $("newSessionPlacement").dataset.unavailableReason;
    note("newSessionMsg", unavailableReason || "", !unavailableReason);
    $("newSessionPlacement").focus();
  });
  $("newSessionClose").addEventListener("click", closeNewSession);
  $("newSessionCancel").addEventListener("click", closeNewSession);
  $("newSessionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("newSessionCreate");
    button.disabled = true;
    try {
      const result = await post("/api/sessions/new", {
        placementId: $("newSessionPlacement").value,
        prompt: $("newSessionPrompt").value.trim(),
        name: $("newSessionName").value.trim(),
      });
      closeNewSession();
      $("newSessionPrompt").value = "";
      $("newSessionName").value = "";
      await loadSessions();
      note(
        "resumeNotice",
        `Session ${result.sessionId ? "created" : "started"} in the Fleet Host.`,
        true,
      );
    } catch (error) {
      note("newSessionMsg", error.message, false);
    } finally {
      button.disabled = false;
    }
  });

  void loadSessions();
};

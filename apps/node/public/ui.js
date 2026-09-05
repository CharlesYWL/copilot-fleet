export const $ = (id) => document.getElementById(id);

export const el = (tag, { dataset = {}, ...props } = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const [name, value] of Object.entries(dataset)) node.dataset[name] = value;
  for (const child of children) node.append(child);
  return node;
};

export const post = async (path, body) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
};

export const note = (id, text, ok) => {
  const target = $(id);
  target.className = text ? "msg " + (ok ? "ok" : "err") : "";
  target.textContent = text;
};

export const showPanel = (id) => {
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === id);
  }
  for (const item of document.querySelectorAll("[data-panel]")) {
    item.classList.toggle("active", item.dataset.panel === id);
  }
};

export const initShell = () => {
  for (const item of document.querySelectorAll("[data-panel]")) {
    item.addEventListener("click", () => showPanel(item.dataset.panel));
  }
};

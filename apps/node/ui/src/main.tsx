import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import { fleetDarkTheme } from "../../../host/ui/src/theme";
import { configureSessionTransport } from "../../../host/ui/src/lib/session-transport";
import "../../../host/ui/src/styles.css";
import { nodeApi } from "./api";
import { App } from "./App";

configureSessionTransport({ basePath: "/api/fleet-sessions", request: nodeApi });

createRoot(document.getElementById("root")!).render(
  <FluentProvider theme={fleetDarkTheme}>
    <div className="fluent-root">
      <App />
    </div>
  </FluentProvider>,
);

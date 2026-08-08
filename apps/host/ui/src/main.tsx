import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import { App } from "./App";
import { fleetDarkTheme } from "./theme";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The layout class goes on a plain wrapper: FluentProvider copies its
        className onto the body-level portal it mounts for popups, so styling it
        would stretch that portal to full screen and cover the app. */}
    <FluentProvider theme={fleetDarkTheme}>
      <div className="fluent-root">
        <App />
      </div>
    </FluentProvider>
  </StrictMode>,
);

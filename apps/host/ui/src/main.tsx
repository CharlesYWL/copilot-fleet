import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import { App } from "./App";
import { AuthGate } from "./components/AuthGate";
import { AdministratorAdded } from "./components/AdministratorAdded";
import { IdentityConfirmed } from "./components/IdentityConfirmed";
import { fleetDarkTheme } from "./theme";
import "./styles.css";

const landing = new URLSearchParams(window.location.search);
const addedAdministratorId = landing.get("administrator_added");
const identityConfirmed = landing.get("reauthenticated") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The layout class goes on a plain wrapper: FluentProvider copies its
        className onto the body-level portal it mounts for popups, so styling it
        would stretch that portal to full screen and cover the app. */}
    <FluentProvider theme={fleetDarkTheme}>
      <div className="fluent-root">
        <AuthGate>
          {addedAdministratorId ? (
            <AdministratorAdded administratorId={addedAdministratorId} />
          ) : identityConfirmed ? (
            <IdentityConfirmed />
          ) : (
            <App />
          )}
        </AuthGate>
      </div>
    </FluentProvider>
  </StrictMode>,
);

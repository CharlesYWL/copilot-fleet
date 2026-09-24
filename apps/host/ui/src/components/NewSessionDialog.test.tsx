import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { describe, expect, it, vi } from "vitest";
import { NewSessionDialog } from "./NewSessionDialog";
import { fleetDarkTheme } from "../theme";

describe("NewSessionDialog defaults", () => {
  it.each([false, true])(
    "preserves drafts and explicit permission choices during refresh: %s",
    (edited) => {
      const dialog = (open: boolean, defaultYolo: boolean) => (
        <FluentProvider theme={fleetDarkTheme}>
          <NewSessionDialog
            open={open}
            defaultYolo={defaultYolo}
            placements={[
              { id: "p", workspaceId: "w", nodeId: "n", localPath: "Q:\\repo" },
            ]}
            onOpenChange={vi.fn()}
            onCreate={vi.fn(async () => true)}
          />
        </FluentProvider>
      );
      const view = render(dialog(true, false));
      fireEvent.change(screen.getByLabelText(/Initial prompt/), {
        target: { value: "Keep my request" },
      });
      fireEvent.change(screen.getByLabelText("Session name"), {
        target: { value: "Keep my name" },
      });
      if (edited) {
        fireEvent.click(screen.getByRole("switch"));
        fireEvent.click(screen.getByRole("switch"));
      }
      view.rerender(dialog(true, true));
      expect(screen.getByLabelText<HTMLInputElement>(/Initial prompt/).value).toBe(
        "Keep my request",
      );
      expect(screen.getByLabelText<HTMLInputElement>("Session name").value).toBe(
        "Keep my name",
      );
      expect(screen.getByRole<HTMLInputElement>("switch").checked).toBe(!edited);

      view.rerender(dialog(false, true));
      view.rerender(dialog(true, true));
      expect(screen.getByLabelText<HTMLInputElement>(/Initial prompt/).value).toBe("");
      expect(screen.getByLabelText<HTMLInputElement>("Session name").value).toBe("");
      expect(screen.getByRole<HTMLInputElement>("switch").checked).toBe(true);
    },
  );
});

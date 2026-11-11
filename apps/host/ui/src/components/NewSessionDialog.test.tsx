import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
            sessions={[]}
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

  it("starts the session on the model and effort picked in the dialog", async () => {
    const option = (id: string, values: string[]) => ({
      id,
      name: id,
      description: "",
      category: id,
      currentValue: values[0] ?? "",
      choices: values.map((value) => ({
        value,
        name: value.toUpperCase(),
        description: "",
      })),
    });
    const onCreate = vi.fn(async () => true);
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <NewSessionDialog
          open
          defaultYolo={false}
          placements={[{ id: "p", workspaceId: "w", nodeId: "n", localPath: "Q:\\repo" }]}
          sessions={[
            {
              configOptions: [
                option("model", ["auto", "opus"]),
                option("reasoning_effort", ["low", "high"]),
              ],
            },
          ]}
          onOpenChange={vi.fn()}
          onCreate={onCreate}
        />
      </FluentProvider>,
    );
    fireEvent.change(screen.getByLabelText(/Initial prompt/), {
      target: { value: "Go" },
    });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "opus" } });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith("p", "Go", false, "", {
        model: "opus",
        reasoningEffort: "high",
      }),
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { PermissionBanner } from "./PermissionBanner";
import { fleetDarkTheme } from "../theme";

const show = (props: Partial<Parameters<typeof PermissionBanner>[0]> = {}) => {
  const onDecide = vi.fn();
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <PermissionBanner title="Run `rm -rf build`" onDecide={onDecide} {...props} />
    </FluentProvider>,
  );
  return onDecide;
};

describe("PermissionBanner", () => {
  it("announces itself, since the prompt can appear while the tab is unattended", () => {
    show();
    expect(screen.getByRole("alert").textContent).toContain("Run `rm -rf build`");
  });

  it("passes the allow option id through, so the agent gets the choice it offered", () => {
    const onDecide = show({ allowOptionId: "allow-once-1" });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledWith("allow_once", "allow-once-1");
  });

  it("denies without an option id", () => {
    const onDecide = show();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("deny");
  });

  it("drops the heading in a tile, where the row has no space for it", () => {
    show({ compact: true });
    expect(screen.queryByText("Permission required")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Run `rm -rf build`");
  });
});

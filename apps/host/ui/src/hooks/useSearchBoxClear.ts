import type { KeyboardEvent } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  /*
   * Fluent folds the clear button away whenever the box loses focus. A search
   * left applied while the operator works through its results should still
   * say so, and clear in one click, so the button stays while it is wanted.
   */
  visible: {
    width: "auto",
    height: "auto",
    overflow: "visible",
    paddingLeft: tokens.spacingHorizontalM,
  },
});

/**
 * Props for a Fluent `SearchBox` that make its clear button usable throughout.
 *
 * Fluent draws the button as a `role="button"` span outside the tab order that
 * only answers clicks. While `shown`, it stays visible and joins the tab order,
 * and Enter or Space stand in for the click, whose own handler clears the box.
 * Spread the result onto the `SearchBox`.
 */
export function useSearchBoxClear(label: string, shown: boolean) {
  const styles = useStyles();
  return {
    ...(shown ? { contentAfter: { className: styles.visible } } : {}),
    dismiss: {
      "aria-label": label,
      title: label,
      tabIndex: shown ? 0 : -1,
      onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      },
    },
  };
}

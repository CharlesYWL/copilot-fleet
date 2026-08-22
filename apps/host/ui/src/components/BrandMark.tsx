import { makeStyles, mergeClasses } from "@fluentui/react-components";
import markUrl from "../assets/copilot-fleet-mark.svg";

const useStyles = makeStyles({
  /**
   * A block, and never the first thing a cramped row gives up.
   *
   * An inline image sits on the text baseline and carries the line box's
   * descender space with it, which is what tips a 30px mark out of line with
   * the word beside it. `flexShrink: 0` is the other half: the mark is the one
   * thing in the brand that must not be squeezed out of shape.
   */
  mark: {
    display: "block",
    flexShrink: 0,
  },
});

export type BrandMarkProps = {
  /** Edge length in px; the artwork is square, so one number is enough. */
  size?: number;
  className?: string;
};

/**
 * The Copilot Fleet mark, from the one file that holds it.
 *
 * It is decorative wherever it appears, because it appears beside the words
 * "Copilot Fleet" — naming it would only make a screen reader say the brand
 * twice. The width and height are attributes as well as intrinsic to the
 * artwork so the row reserves the space before the asset has loaded.
 */
export const BrandMark = ({ size = 24, className }: BrandMarkProps) => {
  const styles = useStyles();
  return (
    <img
      src={markUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={mergeClasses(styles.mark, className)}
    />
  );
};

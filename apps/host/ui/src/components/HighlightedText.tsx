import { Fragment } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { highlightSegments } from "../lib/search-text";

const useStyles = makeStyles({
  /*
   * Brand-tinted rather than the browser's yellow <mark>: amber is reserved for
   * "a person is being waited on", and a search hit is not that.
   */
  match: {
    background: "transparent",
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
    // Forced-colors mode drops the colour, so keep the hit distinguishable.
    "@media (forced-colors: active)": { textDecorationLine: "underline" },
  },
});

type HighlightedTextProps = {
  text: string;
  /** Lowercased search terms; see `searchTerms`. */
  terms: readonly string[];
};

/** `text` with the runs that match the search terms marked. */
export const HighlightedText = ({ text, terms }: HighlightedTextProps) => {
  const styles = useStyles();
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, terms).map((segment, index) =>
        segment.match ? (
          <mark key={index} className={styles.match}>
            {segment.text}
          </mark>
        ) : (
          /*
           * A bare text node, not a <span>: an element's name is computed on
           * its own and trimmed, so the space in "Fix " would be lost and the
           * row announced as "Fixlint". Terms never contain whitespace, so
           * every space lives out here, between the marks.
           */
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
};

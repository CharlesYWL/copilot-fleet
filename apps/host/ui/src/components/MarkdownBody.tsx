import {
  isValidElement,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { terminal } from "../theme";
import { CopyButton } from "./CopyButton";

const useStyles = makeStyles({
  root: {
    position: "relative",
    fontFamily: '"DM Sans", system-ui, sans-serif',
    fontSize: "13.5px",
    lineHeight: "1.6",
    wordBreak: "break-word",
    color: "inherit",
    "& > :first-child": { marginTop: 0 },
    "& > :last-child": { marginBottom: 0 },
    "& p": {
      marginTop: "0",
      marginBottom: "0.65em",
    },
    "& h1, & h2, & h3, & h4": {
      marginTop: "0.9em",
      marginBottom: "0.4em",
      fontWeight: tokens.fontWeightSemibold,
      lineHeight: "1.3",
      color: tokens.colorNeutralForeground1,
    },
    "& h1": { fontSize: "1.35em" },
    "& h2": { fontSize: "1.2em" },
    "& h3": { fontSize: "1.08em" },
    "& ul, & ol": {
      marginTop: "0.2em",
      marginBottom: "0.65em",
      paddingLeft: "1.4em",
    },
    "& li": {
      marginBottom: "0.2em",
    },
    "& li > ul, & li > ol": {
      marginTop: "0.2em",
      marginBottom: "0.2em",
    },
    "& blockquote": {
      margin: "0.5em 0",
      padding: "0.15em 0 0.15em 0.9em",
      borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
      color: tokens.colorNeutralForeground3,
    },
    "& hr": {
      border: "none",
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      margin: "0.9em 0",
    },
    "& a": {
      color: terminal.user,
      textDecoration: "underline",
      textUnderlineOffset: "2px",
    },
    "& table": {
      borderCollapse: "collapse",
      margin: "0.6em 0",
      fontSize: "12.5px",
      width: "100%",
      display: "block",
      overflowX: "auto",
    },
    "& th, & td": {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: "6px 10px",
      textAlign: "left",
    },
    "& th": {
      background: tokens.colorNeutralBackground3,
      fontWeight: tokens.fontWeightSemibold,
    },
    "& :not(pre) > code": {
      fontFamily: terminal.font,
      fontSize: "0.9em",
      background: "rgba(127, 160, 255, 0.12)",
      borderRadius: tokens.borderRadiusSmall,
      padding: "0.1em 0.35em",
    },
  },
  muted: {
    opacity: 0.85,
    fontStyle: "italic",
  },
  withMessageCopy: {
    paddingRight: "36px",
  },
  messageCopy: {
    position: "absolute",
    top: "0",
    right: "0",
  },
  codeBlock: {
    position: "relative",
    margin: "0.55em 0",
    borderRadius: tokens.borderRadiusMedium,
    background: "#0c1220",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: "hidden",
  },
  codeHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "4px 6px 4px 12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: "rgba(255, 255, 255, 0.03)",
  },
  language: {
    fontFamily: terminal.font,
    fontSize: "11px",
    color: tokens.colorNeutralForeground3,
    textTransform: "lowercase",
  },
  codePre: {
    margin: 0,
    padding: "12px 14px",
    overflowX: "auto",
    fontFamily: terminal.font,
    fontSize: "12px",
    lineHeight: "1.55",
    color: terminal.agent,
    "& code": {
      background: "transparent",
      padding: 0,
      fontFamily: "inherit",
      fontSize: "inherit",
      color: "inherit",
    },
  },
});

type MarkdownBodyProps = {
  text: string;
  muted?: boolean;
  /** Show a copy control for the full markdown source. */
  copyable?: boolean;
  className?: string;
};

export const MarkdownBody = ({
  text,
  muted,
  copyable,
  className,
}: MarkdownBodyProps) => {
  const styles = useStyles();
  return (
    <div
      className={mergeClasses(
        styles.root,
        muted && styles.muted,
        copyable && styles.withMessageCopy,
        className,
      )}
    >
      {copyable && text.trim().length > 0 && (
        <span className={styles.messageCopy}>
          <CopyButton text={text} label="Copy message" />
        </span>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};

const CodeBlock = ({ children }: { children?: ReactNode }) => {
  const styles = useStyles();
  const text = nodeText(children).replace(/\n$/, "");
  const language = codeLanguage(children);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span className={styles.language}>{language || "code"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className={styles.codePre}>{children}</pre>
    </div>
  );
};

const nodeText = (node: ReactNode): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return "";
};

const codeLanguage = (node: ReactNode): string => {
  if (!isValidElement<ComponentPropsWithoutRef<"code">>(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const language = codeLanguage(child);
        if (language) return language;
      }
    }
    return "";
  }
  const className = node.props.className;
  if (typeof className === "string") {
    const match = /language-([a-z0-9_+-]+)/i.exec(className);
    if (match) return match[1] ?? "";
  }
  return codeLanguage(node.props.children);
};

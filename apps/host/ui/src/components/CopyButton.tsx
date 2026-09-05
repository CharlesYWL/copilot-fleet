import { useEffect, useState } from "react";
import { Button, makeStyles } from "@fluentui/react-components";
import { Checkmark20Regular, Copy20Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  button: {
    minWidth: "auto",
  },
});

type CopyButtonProps = {
  text: string;
  label?: string;
  size?: "small" | "medium";
  showText?: boolean;
  appearance?: "primary" | "secondary" | "subtle";
};

export const CopyButton = ({
  text,
  label = "Copy",
  showText = false,
  size = showText ? "medium" : "small",
  appearance = showText ? "secondary" : "subtle",
}: CopyButtonProps) => {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), showText ? 2_000 : 1_600);
    return () => clearTimeout(timer);
  }, [copied, showText]);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard can be blocked in insecure contexts; ignore quietly.
    }
  };

  return (
    <Button
      className={showText ? undefined : styles.button}
      appearance={copied ? "subtle" : appearance}
      size={size}
      icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
      aria-label={copied && !showText ? "Copied" : label}
      title={showText ? undefined : copied ? "Copied" : label}
      onClick={() => void handleCopy()}
    >
      {showText ? (copied ? "Copied" : "Copy") : null}
    </Button>
  );
};

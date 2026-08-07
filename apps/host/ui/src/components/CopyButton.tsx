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
};

export const CopyButton = ({ text, label = "Copy", size = "small" }: CopyButtonProps) => {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_600);
    return () => clearTimeout(timer);
  }, [copied]);

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
      className={styles.button}
      appearance="subtle"
      size={size}
      icon={copied ? <Checkmark20Regular /> : <Copy20Regular />}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => void handleCopy()}
    />
  );
};

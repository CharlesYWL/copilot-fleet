import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import {
  Dismiss12Regular,
  Document20Regular,
  Image20Regular,
} from "@fluentui/react-icons";
import {
  attachmentSizeLabel,
  isImageAttachment,
  type DraftAttachment,
} from "../lib/attachments";

const useStyles = makeStyles({
  strip: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    padding: "2px 2px 4px",
  },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    maxWidth: "220px",
    padding: "3px 4px 3px 7px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground3,
  },
  icon: {
    flexShrink: 0,
    fontSize: "14px",
    color: tokens.colorNeutralForeground3,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
  },
  size: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground4,
    fontSize: "11px",
  },
  remove: {
    flexShrink: 0,
    minWidth: "20px",
    width: "20px",
    height: "20px",
    padding: 0,
  },
});

export type AttachmentStripProps = {
  attachments: DraftAttachment[];
  onRemove: (id: string) => void;
};

/** The files queued to go with the next prompt, each removable until it does. */
export const AttachmentStrip = ({ attachments, onRemove }: AttachmentStripProps) => {
  const styles = useStyles();
  if (attachments.length === 0) return null;
  return (
    <div className={styles.strip}>
      {attachments.map((attachment) => (
        <div className={styles.chip} key={attachment.id} title={attachment.name}>
          {isImageAttachment(attachment) ? (
            <Image20Regular className={styles.icon} />
          ) : (
            <Document20Regular className={styles.icon} />
          )}
          <Text className={styles.name}>{attachment.name}</Text>
          <Text className={styles.size}>{attachmentSizeLabel(attachment)}</Text>
          <Button
            className={styles.remove}
            appearance="subtle"
            size="small"
            shape="circular"
            icon={<Dismiss12Regular />}
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
          />
        </div>
      ))}
    </div>
  );
};

import { useState } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Dismiss12Regular, Document20Regular } from "@fluentui/react-icons";
import {
  attachmentDataUrl,
  attachmentSizeLabel,
  isImageAttachment,
  type DraftAttachment,
} from "../lib/attachments";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

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
  thumbnailButton: {
    flexShrink: 0,
    display: "flex",
    width: "28px",
    height: "28px",
    padding: 0,
    overflow: "hidden",
    cursor: "zoom-in",
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "1px",
    },
  },
  thumbnailImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
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
  const [previewId, setPreviewId] = useState<string>();

  if (attachments.length === 0) return null;

  // Looked up rather than stored, so removing the previewed image closes the
  // dialog instead of leaving it showing bytes that will no longer be sent.
  const previewed = attachments.find((attachment) => attachment.id === previewId);

  const handleClosePreview = () => setPreviewId(undefined);

  return (
    <div className={styles.strip}>
      {attachments.map((attachment) => (
        <div className={styles.chip} key={attachment.id} title={attachment.name}>
          {isImageAttachment(attachment) ? (
            <button
              type="button"
              className={styles.thumbnailButton}
              aria-label={`Preview ${attachment.name}`}
              onClick={() => setPreviewId(attachment.id)}
            >
              <img
                className={styles.thumbnailImage}
                src={attachmentDataUrl(attachment)}
                alt=""
              />
            </button>
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
      <ImagePreviewDialog
        image={
          previewed
            ? { name: previewed.name, src: attachmentDataUrl(previewed) }
            : undefined
        }
        onClose={handleClosePreview}
      />
    </div>
  );
};

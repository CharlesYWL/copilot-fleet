import { useEffect, useState } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Attach20Regular, Image20Regular } from "@fluentui/react-icons";
import type { AttachmentSummary } from "@fleet/protocol";
import { attachmentDataUrl } from "../lib/attachments";
import { findSentImage, onSentImagesChange, type SentImage } from "../lib/sent-images";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

const useStyles = makeStyles({
  list: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginTop: "6px",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "260px",
    padding: "2px 7px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
  },
  viewable: {
    cursor: "zoom-in",
    background: "none",
    fontFamily: "inherit",
    ":hover": {
      color: tokens.colorNeutralForeground1,
      border: `1px solid ${tokens.colorNeutralStroke1Hover}`,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "1px",
    },
  },
  icon: {
    flexShrink: 0,
    fontSize: "12px",
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

type SentAttachmentChipProps = {
  sessionId: string;
  attachment: AttachmentSummary;
  sentAt: string;
};

/**
 * The kept copy of a sent image, if this browser has one.
 *
 * Looks again whenever kept images change, because the message can reach the
 * transcript a moment before the save that goes with it finishes.
 */
const useSentImage = (
  sessionId: string,
  attachment: AttachmentSummary,
  sentAt: string,
): SentImage | undefined => {
  const [image, setImage] = useState<SentImage>();
  const isImage = attachment.mimeType.startsWith("image/");
  const { name, mimeType, bytes } = attachment;

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    const lookUp = () => {
      void findSentImage(sessionId, { name, mimeType, bytes }, sentAt).then((found) => {
        if (!cancelled) setImage(found);
      });
    };
    lookUp();
    const unsubscribe = onSentImagesChange(lookUp);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isImage, sessionId, name, mimeType, bytes, sentAt]);

  return image;
};

const SentAttachmentChip = ({
  sessionId,
  attachment,
  sentAt,
}: SentAttachmentChipProps) => {
  const styles = useStyles();
  const image = useSentImage(sessionId, attachment, sentAt);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (!image) {
    return (
      <span className={styles.chip} title={attachment.name}>
        <Attach20Regular className={styles.icon} />
        <span className={styles.name}>{attachment.name}</span>
      </span>
    );
  }

  const handleOpenPreview = () => setPreviewOpen(true);
  const handleClosePreview = () => setPreviewOpen(false);

  return (
    <>
      <button
        type="button"
        className={mergeClasses(styles.chip, styles.viewable)}
        title={`View ${attachment.name}`}
        aria-label={`View ${attachment.name}`}
        aria-haspopup="dialog"
        onClick={handleOpenPreview}
      >
        <Image20Regular className={styles.icon} />
        <span className={styles.name}>{attachment.name}</span>
      </button>
      <ImagePreviewDialog
        image={
          previewOpen ? { name: image.name, src: attachmentDataUrl(image) } : undefined
        }
        onClose={handleClosePreview}
      />
    </>
  );
};

export type SentAttachmentsProps = {
  sessionId: string;
  attachments: readonly AttachmentSummary[];
  /** When the message was sent, to pick the right copy of a reused name. */
  sentAt: string;
};

/**
 * The files that went with a sent message.
 *
 * Only names reach the transcript; an image this browser sent opens again from
 * the copy it kept, and anything else stays a name.
 */
export const SentAttachments = ({
  sessionId,
  attachments,
  sentAt,
}: SentAttachmentsProps) => {
  const styles = useStyles();
  if (attachments.length === 0) return null;
  return (
    <div className={styles.list}>
      {attachments.map((attachment, index) => (
        <SentAttachmentChip
          key={`${index}:${attachment.name}`}
          sessionId={sessionId}
          attachment={attachment}
          sentAt={sentAt}
        />
      ))}
    </div>
  );
};

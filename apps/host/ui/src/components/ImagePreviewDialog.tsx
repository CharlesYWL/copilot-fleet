import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";

const useStyles = makeStyles({
  previewSurface: {
    width: "auto",
    maxWidth: "min(960px, calc(100vw - 32px))",
  },
  previewTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  previewContent: {
    display: "flex",
    justifyContent: "center",
  },
  previewImage: {
    display: "block",
    maxWidth: "100%",
    maxHeight: "70vh",
    objectFit: "contain",
    borderRadius: tokens.borderRadiusMedium,
  },
});

export type PreviewImage = {
  name: string;
  /** Anything an `<img>` accepts; attachments use a data URL. */
  src: string;
};

export type ImagePreviewDialogProps = {
  /** The image to show; the dialog is closed while this is undefined. */
  image: PreviewImage | undefined;
  onClose: () => void;
};

/** One image at a readable size, over whatever opened it. */
export const ImagePreviewDialog = ({ image, onClose }: ImagePreviewDialogProps) => {
  const styles = useStyles();

  const handleOpenChange = (_event: unknown, data: { open: boolean }) => {
    if (!data.open) onClose();
  };

  return (
    <Dialog open={image !== undefined} onOpenChange={handleOpenChange}>
      <DialogSurface className={styles.previewSurface}>
        {image ? (
          <DialogBody>
            <DialogTitle className={styles.previewTitle}>{image.name}</DialogTitle>
            <DialogContent className={styles.previewContent}>
              <img className={styles.previewImage} src={image.src} alt={image.name} />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose}>
                Close
              </Button>
            </DialogActions>
          </DialogBody>
        ) : null}
      </DialogSurface>
    </Dialog>
  );
};

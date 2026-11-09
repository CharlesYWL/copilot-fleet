import type { ComponentProps, ReactNode } from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  root: { flexShrink: 0, minWidth: 0, gap: "inherit" },
  details: { gap: "inherit" },
  summary: {
    cursor: "pointer",
    fontWeight: tokens.fontWeightSemibold,
    "& > h2, & > h3": { display: "inline" },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "4px",
      borderRadius: tokens.borderRadiusMedium,
    },
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: "inherit",
    paddingTop: "12px",
    minWidth: 0,
  },
});

type SettingsSectionProps = Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  "data-setting-id"?: string | undefined;
  collapsible?: boolean;
};

export function SettingsSection({
  title,
  children,
  className,
  "data-setting-id": settingId,
  collapsible = true,
  ...props
}: SettingsSectionProps) {
  const styles = useStyles();
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      {...props}
      className={mergeClasses(styles.root, className)}
      data-setting-id={collapsible ? undefined : settingId}
    >
      {collapsible ? (
        <details className={styles.details} data-setting-id={settingId}>
          <summary className={styles.summary}>{title}</summary>
          <div className={styles.content}>{children}</div>
        </details>
      ) : (
        <>
          {title}
          {children}
        </>
      )}
    </section>
  );
}

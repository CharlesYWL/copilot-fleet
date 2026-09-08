import type { ReactNode } from "react";
import { Link, Text, makeStyles, tokens } from "@fluentui/react-components";

const REGISTER_APP =
  "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app";
const FIND_TENANT =
  "https://learn.microsoft.com/en-us/entra/fundamentals/how-to-find-tenant";
const CREATE_TENANT =
  "https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant";

const useStyles = makeStyles({
  guide: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: "12px",
    overflowWrap: "anywhere",
  },
  summary: {
    cursor: "pointer",
    fontWeight: tokens.fontWeightSemibold,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    marginTop: "12px",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  steps: {
    margin: 0,
    paddingLeft: "20px",
    display: "grid",
    gap: "8px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

function HelpLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
}

export function MicrosoftSignInSetupGuide({
  audience,
}: {
  audience?: "public" | "enterprise";
}) {
  const styles = useStyles();
  return (
    <details className={styles.guide}>
      <summary className={styles.summary}>
        {audience === "public"
          ? "Personal accounts: get your client ID"
          : audience === "enterprise"
            ? "Corporate accounts: get your tenant ID and client ID"
            : "First-time setup: personal or corporate account"}
      </summary>
      <div className={styles.content}>
        <Text className={styles.caption}>
          Already have an approved registration? Use its IDs. Otherwise, prepare it before
          unlocking setup. Help links open in a new tab and keep this page in place. The
          claim code comes from the Host terminal, not Microsoft.
        </Text>
        <HelpLink href="https://entra.microsoft.com">
          Open Microsoft Entra admin center
        </HelpLink>

        {audience !== "enterprise" && (
          <section
            className={styles.section}
            aria-label="Personal Microsoft account setup"
          >
            <Text weight="semibold">
              Personal Microsoft accounts (Outlook, Hotmail, Live)
            </Text>
            <ol className={styles.steps}>
              <li>
                Sign in to Entra and switch to a directory you own or are allowed to
                manage, not your employer&apos;s directory for a private Fleet.
              </li>
              <li>
                Open Entra ID &gt; App registrations &gt; New registration. Name it
                Copilot Fleet and choose{" "}
                <strong>Any Entra ID Tenant + Personal Microsoft accounts</strong> (also
                labeled Accounts in any organizational directory and personal Microsoft
                accounts).
              </li>
              <li>
                Select Register. On the app&apos;s Overview page, copy
                <strong> Application (client) ID</strong> into Fleet. Keep
                <strong> Work/school and personal Microsoft accounts</strong> selected;
                Fleet uses <code>common</code> automatically, so no tenant ID is needed.
              </li>
            </ol>
            <HelpLink href={REGISTER_APP}>
              Personal-account client ID setup guide
            </HelpLink>
            <Text className={styles.caption}>
              An Outlook account alone is not an Entra directory. See{" "}
              <HelpLink href={CREATE_TENANT}>directory setup and eligibility</HelpLink> if
              you do not have one. Tenant creation has subscription and permission
              requirements; if unavailable, ask the Fleet publisher/operator for an
              approved client ID.
            </Text>
          </section>
        )}

        {audience !== "public" && (
          <section
            className={styles.section}
            aria-label="Corporate Microsoft account setup"
          >
            <Text weight="semibold">
              Corporate or work/school accounts (one directory)
            </Text>
            <ol className={styles.steps}>
              <li>
                Sign in with your work account and switch to the organization&apos;s
                directory. Use an approved app or ask your tenant administrator for
                registration permission.
              </li>
              <li>
                Open Entra ID &gt; App registrations &gt; New registration. Choose
                <strong> Single tenant only - your tenant</strong> (also labeled Accounts
                in this organizational directory only), then Register.
              </li>
              <li>
                Copy <strong>Directory (tenant) ID</strong> and
                <strong> Application (client) ID</strong> from the app&apos;s Overview
                page. In Fleet choose <strong>One organization (fixed directory)</strong>{" "}
                and paste both GUIDs, not the domain name or Object ID.
              </li>
            </ol>
            <HelpLink href={REGISTER_APP}>Corporate client ID setup guide</HelpLink>
            <HelpLink href={FIND_TENANT}>Find your corporate tenant ID</HelpLink>
            <Text className={styles.caption}>
              Company approvals and Conditional Access still apply. If registration asks
              for a Service Tree ID or other ownership metadata, ask your owning team or
              tenant administrator. To support personal accounts too, use the public
              option with an approved registration that supports both account types.
            </Text>
          </section>
        )}

        <section
          className={styles.section}
          aria-label="Microsoft app registration checklist"
        >
          <Text weight="semibold">Before saving either configuration</Text>
          <Text>
            In the app, open Authentication &gt; Add a platform &gt; Mobile and desktop
            applications. Add <code>http://localhost:8787/api/auth/entra/callback</code>.
            Replace 8787 with your Host&apos;s API port if different, not the Vite UI port
            5173. Do not select Web or SPA.
          </Text>
          <Text className={styles.caption}>
            Fleet uses public-client authorization code with PKCE. No client secret or
            Microsoft Graph permission is required. Use your own approved client ID, never
            a borrowed Visual Studio or Visual Studio Code client ID.
          </Text>
        </section>
      </div>
    </details>
  );
}

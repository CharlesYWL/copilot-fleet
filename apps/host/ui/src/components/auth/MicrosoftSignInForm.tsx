import { useState } from "react";
import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { AuthStatus } from "@fleet/protocol";

type Configuration = NonNullable<AuthStatus["entra"]>;

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export function MicrosoftSignInForm({
  configuration,
  busy,
  error,
  submitLabel,
  busyLabel,
  onSubmit,
}: {
  configuration?: Configuration | undefined;
  busy: boolean;
  error?: string | undefined;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (configuration: Configuration) => void | Promise<void>;
}) {
  const styles = useStyles();
  const [fixedDirectory, setFixedDirectory] = useState(
    Boolean(configuration && configuration.tenantId !== "common"),
  );
  const [tenantId, setTenantId] = useState(
    configuration?.tenantId === "common" ? "" : (configuration?.tenantId ?? ""),
  );
  const [clientId, setClientId] = useState(configuration?.clientId ?? "");
  const tenantValid = GUID.test(tenantId.trim());
  const clientValid = GUID.test(clientId.trim());
  const canSubmit = clientValid && (!fixedDirectory || tenantValid);

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !canSubmit) return;
        void onSubmit({
          tenantId: fixedDirectory ? tenantId.trim() : "common",
          clientId: clientId.trim(),
        });
      }}
    >
      <Field label="Supported accounts">
        <RadioGroup
          value={fixedDirectory ? "enterprise" : "public"}
          disabled={busy}
          onChange={(_event, data) => setFixedDirectory(data.value === "enterprise")}
        >
          <Radio value="public" label="Work/school and personal Microsoft accounts" />
          <Radio value="enterprise" label="One organization (fixed directory)" />
        </RadioGroup>
      </Field>
      <Text className={styles.caption}>
        {fixedDirectory
          ? "Only accounts in the specified directory can authenticate, including its guests."
          : "Use a registration for accounts in any organizational directory and personal Microsoft accounts. This includes Microsoft corporate accounts where organization policy permits."}{" "}
        The registration&apos;s supported account types must match this choice. Consent
        and Conditional Access policies still apply.
      </Text>
      {fixedDirectory && (
        <Field
          label="Directory (tenant) ID"
          hint="The directory GUID from the app registration, not a domain name."
          validationState={tenantId && !tenantValid ? "error" : "none"}
          {...(tenantId && !tenantValid
            ? { validationMessage: "Enter a valid directory GUID." }
            : {})}
        >
          <Input
            value={tenantId}
            disabled={busy}
            onChange={(_event, data) => setTenantId(data.value)}
          />
        </Field>
      )}
      <Field
        label="Application (client) ID"
        hint="The application GUID from an approved publisher- or operator-owned registration, not a client secret."
        validationState={clientId && !clientValid ? "error" : "none"}
        {...(clientId && !clientValid
          ? { validationMessage: "Enter a valid application (client) GUID." }
          : {})}
      >
        <Input
          value={clientId}
          autoFocus
          disabled={busy}
          onChange={(_event, data) => setClientId(data.value)}
        />
      </Field>
      <Text className={styles.caption}>
        Register <code>http://localhost:&lt;port&gt;/api/auth/entra/callback</code> as a
        Mobile and desktop application (public client), not Web or SPA. Fleet uses
        authorization code with PKCE; no client secret is needed.
      </Text>
      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <Button type="submit" appearance="primary" disabled={busy || !canSubmit}>
        {busy ? busyLabel : submitLabel}
      </Button>
    </form>
  );
}

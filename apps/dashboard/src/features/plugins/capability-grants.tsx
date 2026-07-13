import { Badge, Button } from "../../components/ui";

export function capabilityDescription(capability: string): string {
  const descriptions: Record<string, string> = {
    MEMORY: "Allow this AI employee to save and search organization-scoped runtime memory.",
    LLM: "Allow access to an approved language-model adapter.",
    EVENTS: "Allow publishing and receiving organization-scoped plugin events.",
    TOOLS: "Allow access to approved platform tools.",
    EMAIL: "Allow access to the configured email adapter.",
    CALENDAR: "Allow access to the configured calendar adapter.",
    CRM: "Allow access to the configured CRM adapter.",
    VOICE: "Allow access to approved voice services.",
    SEARCH: "Allow access to the approved search adapter.",
    FILES: "Allow access to plugin-scoped file services."
  };
  return descriptions[capability] ?? "Allow access to this declared platform capability.";
}

export function runtimeReady(status: string, granted: readonly string[]): boolean {
  return status === "ACTIVE" && granted.includes("MEMORY");
}

export function CapabilityGrants({
  declared,
  granted,
  canManage,
  pending,
  onChange
}: {
  declared: readonly string[];
  granted: readonly string[];
  canManage: boolean;
  pending?: string;
  onChange(capability: string, grant: boolean): void;
}) {
  return (
    <section aria-labelledby="capability-grants-title">
      <h3 id="capability-grants-title">Capability Grants</h3>
      <p>Grants control which platform services this installed plugin can use.</p>
      {declared.length ? (
        declared.map((capability) => {
          const isGranted = granted.includes(capability),
            isPending = pending === capability;
          return (
            <div className="admin-toolbar" key={capability} data-capability={capability}>
              <span>
                <strong>{capability}</strong>
                <small>{capabilityDescription(capability)}</small>
              </span>
              <Badge tone={isGranted ? "success" : "neutral"}>
                {isGranted ? "Granted" : "Not granted"}
              </Badge>
              {canManage ? (
                <Button
                  type="button"
                  variant={isGranted ? "secondary" : "primary"}
                  loading={isPending}
                  disabled={isPending}
                  onClick={() => onChange(capability, !isGranted)}
                  aria-label={`${isGranted ? "Revoke" : "Grant"} ${capability}`}
                >
                  {isGranted ? "Revoke" : "Grant"}
                </Button>
              ) : (
                <small>Only Owners and Admins can change grants.</small>
              )}
            </div>
          );
        })
      ) : (
        <p>This plugin declares no grantable platform capabilities.</p>
      )}
    </section>
  );
}

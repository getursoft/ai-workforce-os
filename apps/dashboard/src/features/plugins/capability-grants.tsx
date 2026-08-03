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

/** LLM controls language-model access/spend, so it stays platform-owner-only even for an
 *  organization's own Owner — every other capability is manageable by whoever `canManage` allows. */
export function canManageCapability(capability: string, isOwner: boolean, isPlatformOwner: boolean): boolean {
  if (capability === "LLM") return isPlatformOwner;
  return isOwner;
}

export function CapabilityGrants({
  declared,
  granted,
  isOwner,
  isPlatformOwner,
  pending,
  onChange
}: {
  declared: readonly string[];
  granted: readonly string[];
  isOwner: boolean;
  isPlatformOwner: boolean;
  pending?: string;
  onChange(capability: string, grant: boolean): void;
}) {
  return (
    <section aria-labelledby="capability-grants-title">
      <h3 id="capability-grants-title">Capability Grants</h3>
      <p>Grants control which platform services this installed plugin can use.</p>
      {declared.length ? (
        Array.from(new Set(declared)).map((capability) => {
          const isGranted = granted.includes(capability),
            isPending = pending === capability,
            manageable = canManageCapability(capability, isOwner, isPlatformOwner);
          return (
            <div className="admin-toolbar" key={capability} data-capability={capability}>
              <span>
                <strong>{capability}</strong>
                <small>{capabilityDescription(capability)}</small>
              </span>
              <Badge tone={isGranted ? "success" : "neutral"}>
                {isGranted ? "Granted" : "Not granted"}
              </Badge>
              {manageable ? (
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
              ) : capability === "LLM" ? (
                <small>Only the platform owner can change this.</small>
              ) : (
                <small>Only the organization Owner can change grants.</small>
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

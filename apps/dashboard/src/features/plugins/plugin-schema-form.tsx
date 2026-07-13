import { Input } from "../../components/ui";
import type { PluginConfigurationSchema, PluginSchemaProperty } from "./plugin-api";
export function isSecretProperty(property: PluginSchemaProperty) {
  return property.writeOnly === true || property.format === "password";
}
export function SchemaFields({
  schema,
  values = {},
  secretMode = false
}: {
  schema?: PluginConfigurationSchema | undefined;
  values?: Record<string, unknown> | undefined;
  secretMode?: boolean;
}) {
  const required = new Set(schema?.required ?? []),
    entries = Object.entries(schema?.properties ?? {}).filter(
      ([, property]) => isSecretProperty(property) === secretMode
    );
  if (!entries.length) return null;
  return (
    <div className="admin-form">
      {entries.map(([key, property], index) => (
        <div key={key}>
          <label htmlFor={`plugin-field-${key}`}>
            {property.title ?? humanize(key)}
            {required.has(key) ? <span aria-hidden="true"> *</span> : null}
          </label>
          {control(key, property, values[key], required.has(key), index === 0)}
          {property.description ? (
            <small id={`plugin-field-${key}-description`}>{property.description}</small>
          ) : null}
        </div>
      ))}
    </div>
  );
}
function control(
  key: string,
  property: PluginSchemaProperty,
  value: unknown,
  required: boolean,
  autoFocus: boolean
) {
  const common = {
    id: `plugin-field-${key}`,
    name: `schema:${key}`,
    required,
    "aria-describedby": property.description ? `plugin-field-${key}-description` : undefined,
    autoFocus
  };
  if (property.enum)
    return (
      <select
        className="ui-input"
        {...common}
        defaultValue={String(value ?? property.default ?? "")}
      >
        <option value="" disabled={required}>
          Select…
        </option>
        {property.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  if (property.type === "boolean")
    return (
      <input {...common} type="checkbox" defaultChecked={Boolean(value ?? property.default)} />
    );
  if (property.type === "number" || property.type === "integer")
    return (
      <Input
        {...common}
        type="number"
        step={property.type === "integer" ? 1 : "any"}
        min={property.minimum}
        max={property.maximum}
        defaultValue={value === undefined ? String(property.default ?? "") : String(value)}
      />
    );
  return (
    <Input
      {...common}
      type={isSecretProperty(property) ? "password" : "text"}
      minLength={property.minLength}
      maxLength={property.maxLength}
      defaultValue={isSecretProperty(property) ? "" : String(value ?? property.default ?? "")}
      autoComplete={isSecretProperty(property) ? "new-password" : undefined}
      placeholder={
        isSecretProperty(property) && value !== undefined
          ? "Leave blank to keep existing value"
          : undefined
      }
    />
  );
}
export function valuesFromForm(
  form: HTMLFormElement,
  schema: PluginConfigurationSchema | undefined,
  secretMode: boolean
) {
  const data = new FormData(form),
    values: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema?.properties ?? {})) {
    if (isSecretProperty(property) !== secretMode) continue;
    const raw = data.get(`schema:${key}`);
    if (property.type === "boolean") {
      values[key] = raw !== null;
      continue;
    }
    if (typeof raw !== "string" || raw === "") continue;
    values[key] = property.type === "number" || property.type === "integer" ? Number(raw) : raw;
  }
  return values;
}
function humanize(value: string) {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

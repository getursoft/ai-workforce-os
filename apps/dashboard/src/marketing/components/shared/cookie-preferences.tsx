"use client";

import { useState } from "react";
import { Check } from "lucide-react";

interface CookieCategory {
  key: string;
  label: string;
  description: string;
  locked?: boolean;
}

const categories: CookieCategory[] = [
  { key: "necessary", label: "Strictly Necessary", description: "Required for the website to function and cannot be disabled.", locked: true },
  { key: "analytics", label: "Analytics", description: "Helps us understand how the website is used so we can improve it." },
  { key: "functional", label: "Functional", description: "Remembers preferences such as your cookie choices across visits." },
  { key: "marketing", label: "Marketing", description: "Used to measure the effectiveness of campaigns. Currently unused on this site." },
];

export function CookiePreferences() {
  const [preferences, setPreferences] = useState<Record<string, boolean>>({
    necessary: true,
    analytics: true,
    functional: true,
    marketing: false,
  });
  const [saved, setSaved] = useState(false);

  function toggle(key: string) {
    setPreferences((prev) => ({ ...prev, [key]: !prev[key] }));
    setSaved(false);
  }

  return (
    <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
      <h2 className="text-lg font-bold text-ink">Cookie Preferences</h2>
      <p className="mt-2 text-sm text-muted">
        Choose which categories of cookies you allow. This is a placeholder control — it does not yet write real
        cookies, and will be connected to a consent management platform before production.
      </p>
      <div className="mt-6 space-y-4">
        {categories.map((category) => (
          <div key={category.key} className="flex items-start justify-between gap-4 rounded-xl border border-royal/10 p-4">
            <div>
              <p className="font-semibold text-ink">{category.label}</p>
              <p className="mt-1 text-xs text-muted">{category.description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferences[category.key]}
              aria-label={`Toggle ${category.label} cookies`}
              disabled={category.locked}
              onClick={() => toggle(category.key)}
              className={`focus-ring relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
                preferences[category.key] ? "bg-royal" : "bg-royal/20"
              } ${category.locked ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  preferences[category.key] ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setSaved(true)}
        className="focus-ring mt-6 inline-flex items-center gap-2 rounded-full bg-royal px-6 py-2.5 text-sm font-semibold text-white hover:bg-navy"
      >
        Save Preferences
      </button>
      {saved && (
        <p role="status" className="mt-3 flex items-center gap-1.5 text-sm text-success">
          <Check className="h-4 w-4" aria-hidden="true" /> Preferences saved for this session.
        </p>
      )}
    </div>
  );
}

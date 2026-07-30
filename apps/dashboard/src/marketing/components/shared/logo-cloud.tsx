const departments = ["Travel", "HR", "Finance", "IT", "Sales", "Marketing", "Operations", "Executive"];

export function LogoCloud({ label = "Built for every department" }: { label?: string }) {
  return (
    <div className="text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{label}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        {departments.map((dept) => (
          <span
            key={dept}
            className="rounded-full border border-royal/10 bg-white px-4 py-2 text-sm font-medium text-royal shadow-soft"
          >
            {dept}
          </span>
        ))}
      </div>
    </div>
  );
}

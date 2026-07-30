import {
  LayoutGrid,
  Users,
  MessagesSquare,
  ListChecks,
  BookOpen,
  BarChart3,
  FileBarChart,
  Plug,
  Settings,
  ChevronDown,
  Calendar,
  CheckCircle2,
  Clock,
  IndianRupee,
  ChevronRight,
  Bell,
  ShieldAlert,
} from "lucide-react";

const activity = [
  { icon: CheckCircle2, tone: "text-success", text: "Travel Agent booked itinerary for Priya S.", time: "2m ago" },
  { icon: Clock, tone: "text-saffron", text: "HR Agent awaiting approval on leave request", time: "6m ago" },
];

const sidebarItems = [
  { label: "Overview", icon: LayoutGrid, active: true },
  { label: "AI Employees", icon: Users },
  { label: "Conversations", icon: MessagesSquare },
  { label: "Tasks", icon: ListChecks },
  { label: "Knowledge", icon: BookOpen },
  { label: "Analytics", icon: BarChart3 },
  { label: "Reports", icon: FileBarChart },
  { label: "Integrations", icon: Plug },
  { label: "Settings", icon: Settings },
];

const stats = [
  { label: "Total Conversations", value: "2,846", delta: "+28%", icon: MessagesSquare, tint: "bg-[#E3EEFC] text-[#2C5CB0]" },
  { label: "Tasks Completed", value: "1,472", delta: "+32%", icon: CheckCircle2, tint: "bg-[#E1F5EA] text-[#1E8F58]" },
  { label: "Time Saved", value: "320h", delta: "+40%", icon: Clock, tint: "bg-[#EDE7F9] text-[#6B4FA0]" },
  { label: "Cost Savings", value: "$24,600", delta: "+31%", icon: IndianRupee, tint: "bg-[#FDECD2] text-[#C6720A]" },
];

const chartPoints = [30, 45, 40, 55, 62, 58, 70, 66, 78, 74, 88, 96];

export function DashboardPreview() {
  const width = 460;
  const height = 140;
  const max = Math.max(...chartPoints);
  const step = width / (chartPoints.length - 1);
  const linePath = chartPoints
    .map((point, i) => `${i === 0 ? "M" : "L"} ${i * step} ${height - (point / max) * height}`)
    .join(" ");
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  return (
    <div
      aria-hidden="true"
      className="animate-float mx-auto w-full max-w-2xl overflow-hidden rounded-card border border-royal/10 bg-white shadow-card"
    >
      <div className="flex">
        <aside className="hidden w-40 flex-col border-r border-royal/10 bg-cream/40 p-3 sm:flex">
          <nav className="flex flex-col gap-0.5">
            {sidebarItems.map((item) => (
              <div
                key={item.label}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] font-medium ${
                  item.active ? "bg-saffron/15 text-saffron" : "text-muted"
                }`}
              >
                <item.icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{item.label}</span>
              </div>
            ))}
          </nav>
          <div className="mt-auto flex items-center gap-2 rounded-lg bg-white px-2 py-2 text-[10px] shadow-soft">
            <div className="h-6 w-6 flex-shrink-0 rounded-full bg-royal/10" />
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink">Arjun Singh</p>
              <p className="truncate text-muted">Acme Corp</p>
            </div>
          </div>
        </aside>

        <div className="flex-1 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-ink">Overview</p>
              <p className="text-[11px] text-muted">Here&apos;s what&apos;s happening with your AI workforce today.</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-1 rounded-full border border-royal/10 px-2.5 py-1 text-[10px] font-medium text-muted sm:flex">
                <Calendar className="h-3 w-3" />
                May 12 – May 18
              </div>
              <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-royal/10 text-muted">
                <Bell className="h-3 w-3" />
                <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-saffron text-[6px] font-bold text-white">
                  3
                </span>
              </span>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-xl border border-royal/10 p-2.5">
                <div className={`mb-2 flex h-6 w-6 items-center justify-center rounded-lg ${stat.tint}`}>
                  <stat.icon className="h-3 w-3" />
                </div>
                <p className="text-[10px] text-muted">{stat.label}</p>
                <p className="text-sm font-bold text-ink">{stat.value}</p>
                <p className="text-[9px] font-semibold text-success">{stat.delta} vs last 7 days</p>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-[1.6fr_1fr]">
            <div className="rounded-xl border border-royal/10 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold text-ink">Conversations Over Time</p>
                <span className="flex items-center gap-0.5 text-[9px] text-muted">
                  Daily <ChevronDown className="h-2.5 w-2.5" />
                </span>
              </div>
              <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#F28C00" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#F28C00" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={areaPath} fill="url(#chart-fill)" />
                <path d={linePath} fill="none" stroke="#062B73" strokeWidth="2" />
              </svg>
            </div>
            <div className="rounded-xl border border-royal/10 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold text-ink">Top AI Employee</p>
                <span className="text-[9px] font-medium text-saffron">View all</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-[#E3EEFC]" />
                <div>
                  <p className="text-[11px] font-semibold text-ink">Travel Agent</p>
                  <p className="text-[9px] text-success">1,284 conversations · +35%</p>
                </div>
              </div>
              <div className="mt-3 flex gap-1">
                <span className="h-1 w-3 rounded-full bg-saffron" />
                <span className="h-1 w-3 rounded-full bg-royal/15" />
                <span className="h-1 w-3 rounded-full bg-royal/15" />
              </div>
            </div>
          </div>

          <div className="mt-2 rounded-xl border border-royal/10 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold text-ink">Recent Activity</p>
              <span className="flex items-center gap-1 rounded-full bg-saffron/15 px-2 py-0.5 text-[9px] font-semibold text-saffron">
                <ShieldAlert className="h-2.5 w-2.5" />3 pending approvals
              </span>
            </div>
            <ul className="space-y-1.5">
              {activity.map((item) => (
                <li key={item.text} className="flex items-center gap-2 text-[10px] text-muted">
                  <item.icon className={`h-3 w-3 flex-shrink-0 ${item.tone}`} />
                  <span className="truncate">{item.text}</span>
                  <span className="ml-auto flex-shrink-0 text-[9px] text-muted/70">{item.time}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-2 flex items-center justify-between rounded-xl border border-royal/10 px-3 py-2 text-[10px]">
            <span className="flex items-center gap-1.5 text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              All systems operational
            </span>
            <span className="flex items-center gap-1 text-muted">
              99.99% uptime <ChevronRight className="h-3 w-3" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

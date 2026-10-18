import SwiftUI
import KreviaCore

extension Color {
    /// `0xRRGGBB` — lets brand colors below be copy-pasted straight from the dashboard's CSS hex values
    /// instead of hand-converted to 0–1 floats (error-prone, hard to diff against the source of truth).
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// Krevia brand palette — values copied verbatim from the web dashboard's `:root` tokens
/// (apps/dashboard/src/app/globals.css) so the app reads as the same product, not a reskin.
/// Do not introduce colors outside this palette.
enum KreviaTheme {
    static let primary = Color(hex: 0x062b73) // --primary / --brand-royal
    static let primaryStrong = Color(hex: 0x031b46) // --primary-strong / --brand-navy
    static let accent = Color(hex: 0xf28c00) // --accent / --brand-saffron
    static let accentStrong = Color(hex: 0xd97b00) // --accent-strong
    static let success = Color(hex: 0x1baa63) // --success / --brand-success
    static let warning = Color(hex: 0xa15c00) // --warning
    static let danger = Color(hex: 0xb02a37) // --danger

    /// The four `stat-tint--*` icon-badge colors from the dashboard's own stat cards
    /// (dashboard-home.tsx / globals.css) — reused here verbatim for the Home nav cards.
    static let statBlue = Color(hex: 0x1d4ed8)
    static let statPurple = Color(hex: 0x7c3aed)

    static let background = Color(hex: 0xfdf7ec) // --background / --brand-ivory
    static let surface = Color.white // --surface-strong
    static let ink = Color(hex: 0x102247) // --foreground / --brand-ink
    static let muted = Color(hex: 0x586780) // --muted / --brand-muted
    static let border = Color(hex: 0x586780).opacity(0.18) // --border
}

extension View {
    /// Matches `.ui-card` (apps/dashboard globals.css): 24px radius, soft shadow, hairline border.
    func kreviaCard() -> some View {
        self
            .padding(16)
            .background(KreviaTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(KreviaTheme.border, lineWidth: 1))
            .shadow(color: KreviaTheme.ink.opacity(0.08), radius: 15, x: 0, y: 6)
    }

    /// Standard page background, applied once per screen root.
    func kreviaScreen() -> some View {
        self
            .background(KreviaTheme.background)
            .navigationBarTitleDisplayMode(.large)
    }
}

/// Shared metric tile used in Usage/Employees detail screens — an icon badge plus a title/value pair.
/// Typography mirrors `.dashboard-stat-card__value`/`__label` (1.7rem/800 and 0.8rem/muted).
struct MetricTile: View {
    let title: String
    let value: String
    var icon: String? = nil
    var color: Color = KreviaTheme.ink

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let icon {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(color)
                    .frame(width: 32, height: 32)
                    .background(color.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            Text(value).font(.system(size: 26, weight: .heavy)).foregroundStyle(KreviaTheme.ink)
            Text(title).font(.caption).foregroundStyle(KreviaTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .kreviaCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value)")
    }
}

/// Initials avatar — used in headers wherever a user/org identity needs a visual anchor.
struct InitialsAvatar: View {
    let text: String
    var diameter: CGFloat = 48

    private var initials: String {
        let letters = text.split(separator: " ").compactMap { $0.first }
        return String(letters.prefix(2)).uppercased()
    }

    var body: some View {
        Circle()
            .fill(LinearGradient(colors: [KreviaTheme.primary, KreviaTheme.primaryStrong], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: diameter, height: diameter)
            .overlay(
                Text(initials.isEmpty ? "?" : initials)
                    .font(.system(size: diameter * 0.38, weight: .semibold))
                    .foregroundStyle(.white)
            )
            .accessibilityHidden(true)
    }
}

/// Home-screen navigation card — icon badge + label, matching the dashboard sidebar's nav items
/// (icon + text, same label strings). Centered, like an app-launcher tile: icon in the middle,
/// label centered beneath it — not a left-aligned stat card.
struct NavCard: View {
    let title: String
    let icon: String
    let tint: Color

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(tint)
                .frame(width: 44, height: 44)
                .background(tint.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(KreviaTheme.ink)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 110)
        .kreviaCard()
    }
}

struct StatusBadge: View {
    let status: LeadStatus

    var tone: Color {
        switch status {
        case .new: return KreviaTheme.accentStrong
        case .contacted, .qualified, .followUp: return KreviaTheme.muted
        case .converted: return KreviaTheme.success
        case .lost: return KreviaTheme.danger
        }
    }

    var body: some View {
        Text(status.displayName)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tone.opacity(0.15))
            .foregroundStyle(tone)
            .clipShape(Capsule())
            .accessibilityLabel("Status: \(status.displayName)")
    }
}

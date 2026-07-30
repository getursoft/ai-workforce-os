import { ImageResponse } from "next/og";
import { siteConfig } from "@/content/site";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#062B73",
          color: "#FFFFFF",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            width: 88,
            height: 88,
            borderRadius: 20,
            background: "#031B46",
            border: "2px solid #F5B942",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 32,
          }}
        >
          <div
            style={{
              display: "flex",
              width: 36,
              height: 36,
              borderRadius: 999,
              border: "3px solid #F5B942",
            }}
          />
        </div>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 700 }}>{siteConfig.name}</div>
        <div style={{ display: "flex", fontSize: 28, color: "#F5B942", marginTop: 16 }}>
          {siteConfig.tagline}
        </div>
      </div>
    ),
    { ...size }
  );
}

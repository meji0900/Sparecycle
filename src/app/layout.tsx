import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { FUNDING } from "@/lib/funding-copy";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const description =
  FUNDING.metaDescription;

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: { default: `Sparecycle — ${FUNDING.tagline.replace(/^(Idle|Your)\b/, (w) => w.toLowerCase()).replace(/\.$/, "")}`, template: "%s · Sparecycle" },
  description,
  openGraph: {
    title: "Sparecycle",
    description,
    type: "website",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: `Sparecycle: ${FUNDING.tagline}` }],
  },
  twitter: { card: "summary_large_image", title: "Sparecycle", description, images: ["/og.jpg"] },
  // The changelog feed, discoverable from every page (feed readers, HEY Research).
  alternates: { types: { "application/rss+xml": [{ url: "/changelog.xml", title: "Sparecycle changelog" }] } },
  // HEY Research (heyresearch.xyz) ownership check for sparecycle.tech; the same code is in /.well-known/hey-research.txt.
  other: { "hey-research-verification": "pcG-9Qu1WPmMDpZRlQ1ShysEQ-SlXRyv" },
};

export const viewport: Viewport = {
  themeColor: "#0c0c0c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-dvh bg-coal text-text">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-s focus:bg-signal focus:px-3 focus:py-2 focus:text-signal-ink"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}

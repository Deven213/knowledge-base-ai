import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { NavigationTracker } from "@/components/BackButton";
import { FeatureProvider } from "@/components/features/FeatureProvider";
import { BRAND } from "@/lib/brand";
import { getFeatureAvailability } from "@/server/features/service";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.description,
};

// Feature flags are read per request, so every page reflects the current settings.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={inter.className}>
        <FeatureProvider availability={getFeatureAvailability()}>
          <NavigationTracker />
          {children}
        </FeatureProvider>
      </body>
    </html>
  );
}

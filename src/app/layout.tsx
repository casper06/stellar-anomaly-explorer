import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Stellar Anomaly Explorer",
  description: "Stellar anomaly explorer with real data from Kepler/Gaia",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${jetbrains.variable} font-mono`}>
        {children}
      </body>
    </html>
  );
}

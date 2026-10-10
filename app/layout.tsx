import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Self hosted by next/font at build time: the browser never asks Google.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    template: "%s · Nile Hands-On Labs",
    default: "Nile Hands-On Labs",
  },
  description: "Reserve a remote Nile lab and get hands on with real gear.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}

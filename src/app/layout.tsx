import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dhruva",
  description:
    "Dhruva — deterministic Salesforce delivery harness. Attach a project folder and drive gated, auditable delivery workflows with any coding agent.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}

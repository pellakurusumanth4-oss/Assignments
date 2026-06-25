import type { Metadata } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "ACME Refund Agent",
  description:
    "AI customer-support agent that processes or denies e-commerce refunds",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased" data-scroll-behavior="smooth">
      <body className="flex min-h-full flex-col text-slate-900">
        <Nav />
        {children}
      </body>
    </html>
  );
}

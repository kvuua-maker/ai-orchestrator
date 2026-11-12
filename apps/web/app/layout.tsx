export const metadata = { title: "AI Orchestrator", description: "Universal RPA Agent" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="uk"><body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#0b0d12", color: "#e6e8ee" }}>{children}</body></html>);
}

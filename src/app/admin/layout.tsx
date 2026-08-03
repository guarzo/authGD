export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 1100, margin: "2rem auto", padding: "0 1rem" }}>
      <nav style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <strong>authGD admin</strong>
        <a href="/admin/accounts">Accounts</a>
        <a href="/admin/audit">Audit log</a>
        <a href="/admin/sync">Sync</a>
        <a href="/account">Your account</a>
      </nav>
      {children}
    </div>
  );
}

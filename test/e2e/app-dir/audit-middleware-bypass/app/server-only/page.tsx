export default function ServerOnlyPage() {
  void process.env.AUDIT_SECRET

  return <p id="server-only-status">server-only page</p>
}

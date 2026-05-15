export default async function DynamicAuditPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params

  if (slug === 'admin') {
    return <p id="dynamic-secret">DYNAMIC TOP SECRET PAYLOAD</p>
  }

  return <p id="dynamic-public">dynamic public payload: {slug}</p>
}

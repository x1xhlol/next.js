export default async function handler(req, res) {
  try {
    await res.revalidate('/')
    res.status(200).json({ ok: true })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

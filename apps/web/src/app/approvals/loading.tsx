export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ width: '30%', height: 22 }} />
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton" style={{ width: '80%' }} />
    </main>
  )
}

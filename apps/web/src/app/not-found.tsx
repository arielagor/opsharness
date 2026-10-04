import Link from 'next/link'

export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <div className="empty">
        There is no such run in this account. <Link href="/">Back to runs</Link>
      </div>
    </main>
  )
}

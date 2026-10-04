import { yoga } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return yoga.handleRequest(request, {})
}

export async function POST(request: Request) {
  return yoga.handleRequest(request, {})
}

'use client'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { fetchHipparcosCatalog, CatalogStar } from '@/lib/starCatalog'
import HUD from '@/components/HUD'
import AnomalyPanel from '@/components/AnomalyPanel'

const StarField = dynamic(() => import('@/components/StarField'), { ssr: false })

export default function Home() {
  const [stars, setStars] = useState<CatalogStar[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchHipparcosCatalog().then(catalog => {
      setStars(catalog)
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div style={{
        width: '100vw', height: '100vh', background: '#000',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'JetBrains Mono, monospace', gap: 16,
      }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'radial-gradient(circle at 35% 35%, #4cc9f0, #0a2a4a)', boxShadow: '0 0 30px rgba(76,201,240,0.5)' }} />
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', letterSpacing: 3 }}>LOADING STAR CATALOG...</div>
      </div>
    )
  }

  return (
    <main style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000' }}>
      <StarField stars={stars} />
      <HUD />
      <AnomalyPanel />
    </main>
  )
}

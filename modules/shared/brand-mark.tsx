type BrandKind = 'logo' | 'stock' | 'fleet'

const SRC: Record<BrandKind, string> = {
  logo: '/brand/logo.png',
  stock: '/brand/stock.png',
  fleet: '/brand/fleet.png',
}

export function BrandMark({ kind = 'logo', className = 'brand-mark', label = '' }: { kind?: BrandKind; className?: string; label?: string }) {
  return <img className={className} src={SRC[kind]} alt={label} />
}

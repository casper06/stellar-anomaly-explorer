'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type Star } from '@/lib/store'
import { selectStarAndFetchCurve } from '@/lib/selectStar'

/**
 * @description Minimum query length before we start showing suggestions.
 * Two chars keeps typing "K0" or "TIC" from firing a suggestion pass
 * for every single character in a longer identifier; below that the
 * match set would be too broad to be useful.
 */
const MIN_QUERY_LEN = 2

/**
 * @description Debounce delay in milliseconds between the last keystroke
 * and the suggestion recompute. 120 ms is short enough to feel
 * "instant" while dropping intermediate re-renders during fast typing.
 * The match runs against the in-memory catalog only (no network), so
 * we don't need heavy debouncing.
 */
const DEBOUNCE_MS = 120

/**
 * @description Maximum number of suggestion rows shown in the dropdown.
 * Kept low so the dropdown stays scannable at a glance.
 */
const MAX_SUGGESTIONS = 8

/**
 * @description Normalizes a string for lookup: lowercased and stripped
 * of every character that isn't a letter, digit, or dot. Turns
 * "KIC 8462852", "kic8462852", "KIC-8462852", and "kic 8462852 "
 * into the same key so the user doesn't have to remember exact
 * formatting when searching.
 * @param s Any string; empty / null returns empty.
 * @returns Normalized key suitable for `includes` matching.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.]/g, '')
}

/**
 * @description One dropdown entry: the matched star plus, when the match
 * came from a resolved SIMBAD alias rather than the catalog id/name, the
 * alias that matched — so the row can show WHY it appeared for a query
 * that doesn't visibly occur anywhere in it.
 */
interface Suggestion {
  star: Star
  via: string | null
}

/**
 * @description Ranks a matched star against the normalized query. Lower
 * is better. Exact matches on id or name come first, then prefix
 * matches, then substring matches. Within the same tier the shorter
 * match string ranks higher — "K02357.01" beats "K02357.02" for the
 * query "k02357" only when the shorter one appears first, but both
 * appear together and sorting keeps them in catalog order otherwise.
 *
 * `aliases` are SIMBAD common names already resolved for this star (see
 * `resolvedIdentities` in the store). They match one tier BELOW the
 * equivalent catalog match, so a query that hits both a catalog id and
 * someone else's alias still ranks the catalog hit first.
 * @param star Candidate star from the catalog.
 * @param normQuery Normalized query key.
 * @param aliases Resolved SIMBAD common names for this star, if any.
 * @returns Rank + the alias that matched (when the hit came from one);
 * rank -1 means no match.
 */
function rank(
  star: Star,
  normQuery: string,
  aliases: readonly string[] = [],
): { rank: number; via: string | null } {
  const idKey = normalize(star.id)
  const nameKey = normalize(star.name)
  if (idKey === normQuery || nameKey === normQuery) return { rank: 0, via: null }
  if (idKey.startsWith(normQuery) || nameKey.startsWith(normQuery)) return { rank: 1, via: null }

  // Alias exact/prefix beat a catalog SUBSTRING hit: someone typing
  // "boyajian" means Boyajian's Star, not a coincidental id substring.
  for (const alias of aliases) {
    const k = normalize(alias)
    if (k === normQuery) return { rank: 1.5, via: alias }
  }

  if (idKey.includes(normQuery) || nameKey.includes(normQuery)) return { rank: 2, via: null }

  for (const alias of aliases) {
    const k = normalize(alias)
    if (k.startsWith(normQuery)) return { rank: 2.5, via: alias }
    if (k.includes(normQuery)) return { rank: 2.75, via: alias }
  }

  // KOI stem match: user typed "K02357.02" but the catalog only stores
  // "K02357.01" (one KOI-per-KIC after dedupe). Strip anything after the
  // first "." off both sides — this makes the sibling planet designation
  // also find the parent star. Applied only when the query itself
  // contains a "." so we don't collapse "KIC" prefixes here.
  if (normQuery.includes('.')) {
    const stemQuery = normQuery.split('.')[0]
    const stemName = nameKey.split('.')[0]
    if (stemQuery.length >= MIN_QUERY_LEN && stemQuery === stemName) return { rank: 3, via: null }
  }
  return { rank: -1, via: null }
}

/**
 * @description Search field + dropdown in the top-left of the HUD, next
 * to the app title. Searches the in-memory `anomalyStars` catalog
 * (KOI + TOI + KNOWN_ANOMALIES seeds) by id and name; no network
 * calls. Selection flies the camera to the star AND runs the full
 * `selectStarAndFetchCurve` flow so the AnomalyPanel opens with the
 * right light curve for that star, not a stale one from a previous
 * selection.
 *
 * Interaction:
 * - Type ≥ 2 chars → dropdown opens with up to 8 ranked suggestions.
 * - ↓ / ↑ move highlight; Enter selects the highlighted row; Esc
 *   closes without selecting.
 * - Click a row → selects.
 * - Click outside → dismisses.
 * @returns Fixed-position input + dropdown UI. No props needed.
 */
export default function StarSearch() {
  const anomalyStars = useStore(s => s.anomalyStars)
  const requestFlyTo = useStore(s => s.requestFlyTo)
  // SIMBAD common names resolved so far this session (phase B3
  // mechanism (a)) — folded into the match set for free. Coverage is
  // visited-stars-only by design; see the empty-state copy below.
  const resolvedIdentities = useStore(s => s.resolvedIdentities)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce the query → debouncedQuery. Any new keystroke resets the
  // timer, so bursts collapse to a single suggestion recompute at the
  // end of the burst.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // Reset the keyboard highlight to row 0 whenever the query changes,
  // so it doesn't point past the end of a shrunken suggestion list.
  useEffect(() => { setHighlight(0) }, [debouncedQuery])

  // Click-outside dismiss. Registers on the document because focusing
  // the input needs to keep the dropdown open, but a click on the sky
  // canvas or another HUD element must close it.
  useEffect(() => {
    if (!isFocused) return
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setIsFocused(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isFocused])

  // Compute suggestions from the debounced query. Runs on catalog and
  // query changes only; typing does NOT recompute until the debounce
  // fires.
  const suggestions = useMemo<Suggestion[]>(() => {
    const normQuery = normalize(debouncedQuery)
    if (normQuery.length < MIN_QUERY_LEN) return []
    const scored: { star: Star; rank: number; via: string | null }[] = []
    for (const star of anomalyStars) {
      const aliases = resolvedIdentities.get(star.id)?.commonNames
      const r = rank(star, normQuery, aliases)
      if (r.rank < 0) continue
      scored.push({ star, rank: r.rank, via: r.via })
      // Early exit: once we've seen a lot more than MAX_SUGGESTIONS we
      // can stop scanning. Rank 0/1 hits are rare enough that this
      // rarely leaves better candidates on the table.
      if (scored.length >= MAX_SUGGESTIONS * 4) break
    }
    scored.sort((a, b) => a.rank - b.rank)
    return scored.slice(0, MAX_SUGGESTIONS).map(x => ({ star: x.star, via: x.via }))
  }, [anomalyStars, debouncedQuery, resolvedIdentities])

  const normQueryLen = normalize(debouncedQuery).length
  const showDropdown = isFocused && normQueryLen >= MIN_QUERY_LEN

  function pick(star: Star) {
    requestFlyTo(star.ra, star.dec)
    void selectStarAndFetchCurve(star)
    setIsFocused(false)
    setQuery('')
    setDebouncedQuery('')
    inputRef.current?.blur()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setIsFocused(false)
      inputRef.current?.blur()
      return
    }
    if (!showDropdown || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(suggestions.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = suggestions[highlight]
      if (target) pick(target.star)
    }
  }

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', pointerEvents: 'auto' }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => setIsFocused(true)}
        onKeyDown={onKeyDown}
        placeholder="Search star (KIC, KOI, TOI, name)"
        aria-label="Search stars"
        style={{
          width: 260,
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.6)',
          border: '1px solid rgba(76,201,240,0.35)',
          borderRadius: 4,
          color: 'white',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          letterSpacing: 1,
          outline: 'none',
        }}
      />
      {showDropdown && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            width: 260,
            background: 'rgba(0,0,0,0.9)',
            border: '1px solid rgba(76,201,240,0.25)',
            borderRadius: 4,
            backdropFilter: 'blur(6px)',
            maxHeight: 320,
            overflowY: 'auto',
            zIndex: 20,
          }}
        >
          {suggestions.length === 0 ? (
            <div
              style={{
                padding: '10px 12px',
                fontSize: 10,
                color: 'rgba(255,255,255,0.5)',
                letterSpacing: 1,
              }}
            >
              <div>No star found matching &quot;{debouncedQuery}&quot;</div>
              {/* Sets expectations honestly: alternate names are searchable
                  only for stars already opened this session (or still in the
                  server cache), because that is when SIMBAD was consulted.
                  Universal common-name search needs a query per keystroke,
                  which CDS's rate policy rules out — that is the separate
                  press-Enter-to-ask escape hatch, not built yet. Do not
                  reword this into a promise of universal name search. */}
              <div
                style={{
                  marginTop: 6,
                  fontSize: 9,
                  color: 'rgba(255,255,255,0.3)',
                  letterSpacing: 0.3,
                  lineHeight: 1.5,
                }}
              >
                Catalog ids (KIC, KOI, TOI) always work. Common names such as
                &quot;Boyajian&apos;s Star&quot; are searchable only for stars
                you have already opened.
              </div>
            </div>
          ) : (
            suggestions.map(({ star, via }, i) => (
              <SuggestionRow
                key={star.id}
                star={star}
                via={via}
                highlighted={i === highlight}
                onHover={() => setHighlight(i)}
                onClick={() => pick(star)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * @description One row inside the suggestion dropdown. Shows the star's
 * name (bold), its id (dim), and — if present — mag and quadrant on
 * a second line. Highlighting is prop-driven so keyboard navigation
 * and mouse hover use the same visual state.
 * @param star The suggestion.
 * @param via The SIMBAD alias that produced this match, when the query
 * matched neither the id nor the catalog name — shown so a row whose
 * visible text doesn't contain the query still explains itself.
 * @param highlighted True when this row is the active keyboard target.
 * @param onHover Called when the mouse enters — moves the highlight.
 * @param onClick Called when the row is clicked — picks the star.
 * @returns One list-item row.
 */
function SuggestionRow({
  star,
  via,
  highlighted,
  onHover,
  onClick,
}: {
  star: Star
  via?: string | null
  highlighted: boolean
  onHover: () => void
  onClick: () => void
}) {
  return (
    <div
      onMouseEnter={onHover}
      onMouseDown={e => { e.preventDefault(); onClick() }}
      style={{
        padding: '8px 12px',
        cursor: 'pointer',
        background: highlighted ? 'rgba(76,201,240,0.15)' : 'transparent',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 11, color: 'white', letterSpacing: 1, fontWeight: 700 }}>
          {star.name}
        </span>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>
          {star.id}
        </span>
      </div>
      {via && (
        <div style={{ fontSize: 9, color: 'rgba(76,201,240,0.75)', letterSpacing: 0.3 }}>
          ↳ {via}
        </div>
      )}
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', letterSpacing: 1 }}>
        MAG {star.magnitude.toFixed(1)}
        {star.quadrant ? <> · QUAD {star.quadrant}</> : null}
        {star.source ? <> · {star.source.toUpperCase()}</> : null}
      </div>
    </div>
  )
}

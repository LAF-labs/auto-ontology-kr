/**
 * Browser half of @ours/ontology-map: the 데이터 지도 panel in the sidebar list.
 *
 * Draws the business terms of the connected catalog as dots and the links
 * between them as lines, in SVG with no chart library: drag a dot, drag the
 * background to move, wheel or the +/− buttons to zoom, and search by name.
 * The first view holds the main entities (those confirmed analyses use, then
 * the most linked); 모두 보기 shows every entity. Positions come from the
 * host (src/layout.js), so the map looks the same on every visit.
 *
 * Clicking a dot opens the side panel: the business name and description,
 * main fields with their meaning, linked entities, and the confirmed analyses
 * that use it. Table and column names appear only under 자세히, in small type.
 *
 * Data comes from the host routes /api/ontology-map/* only; the page never
 * calls the Auto-ontology gateway. Read-only: nothing here edits the catalog.
 */
window.__ModuleLoader__.load({
  id: '@ours/ontology-map',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState, useCallback } = React

    const PANEL = 'ours-ontology-map'
    const FIELDS_SHOWN = 7
    const SEARCH_RESULTS = 8

    const t = {
      menu: '데이터 지도',
      lead: '연결된 회사 데이터를 이렇게 이해하고 있습니다.',
      readOnly: '읽기 전용으로 연결되어 있습니다',
      readAt: when => `${when}에 읽음`,
      counts: (entities, analyses) => analyses > 0 ? `데이터 ${entities}개 · 확인된 분석 ${analyses}개` : `데이터 ${entities}개`,
      loading: '데이터 지도를 그리는 중…',
      reload: '다시 불러오기', reloading: '불러오는 중…',
      mainOnly: count => `주요 데이터 ${count}개`, showAll: count => `모두 보기 (${count}개)`,
      search: '데이터 이름으로 찾기', noMatch: '찾는 이름의 데이터가 없습니다.',
      legendConfirmed: '확인된 분석이 쓰는 데이터', legendOther: '그 밖의 데이터', legendLine: '선은 서로 이어진 데이터',
      zoomIn: '확대', zoomOut: '축소', fit: '화면에 맞추기',
      hint: '점을 누르면 무엇이 들어 있는지 보입니다. 끌어서 옮기고, 휠로 확대합니다.',
      empty: '아직 정리된 데이터가 없습니다. 회사 데이터를 연결하고 정리가 끝나면 여기에 무엇이 들어 있는지 보입니다.',
      failed: {
        unreachable: '데이터 연결이 지금 응답하지 않아 데이터 지도를 불러오지 못했습니다. 잠시 뒤 다시 불러와 주세요.',
        setup: '데이터 연결 설정이 끝나지 않아 데이터 지도를 볼 수 없습니다. 담당자에게 알려 주세요.',
        other: '데이터 지도를 불러오지 못했습니다. 잠시 뒤 다시 불러와 주세요.',
      },
      stale: when => `지금 데이터 연결이 응답하지 않아 ${when}에 읽은 지도를 보여 드립니다.`,
      analysesMissing: '확인된 분석 목록을 이번에는 읽지 못해 지도에 표시하지 않았습니다.',
      unnamed: '이름 정리 전',
      close: '닫기',
      confirmedCount: n => `확인된 분석 ${n}개`,
      noDescription: '아직 설명이 정리되지 않았습니다.',
      fields: '주요 항목', moreFields: n => `모든 항목 보기 (${n}개)`, fewerFields: '주요 항목만 보기', noFields: '정리된 항목이 없습니다.',
      fieldsFailed: '항목 목록을 불러오지 못했습니다.',
      connected: '이어진 데이터', noConnected: '이어진 데이터가 없습니다.',
      analyses: '이 데이터를 쓰는 확인된 분석', noAnalyses: '아직 이 데이터를 쓰는 확인된 분석이 없습니다.', confirmed: '확인됨',
      questions: '이 데이터로 물어볼 수 있는 질문',
      details: '자세히', sourceTables: '원본 테이블', sourceFields: '항목의 원본 이름',
      entityFailed: '이 데이터의 설명을 불러오지 못했습니다. 잠시 뒤 다시 눌러 주세요.',
      footnote: '읽기만 합니다. 설명이 실제와 다르면 담당자에게 알려 주세요.',
    }

    async function api(path) {
      let response
      try {
        response = await fetch(path)
      } catch (error) {
        return { ok: false, error: { code: 'network', message: String(error?.message ?? error) } }
      }
      let json
      try { json = await response.json() } catch { json = undefined }
      if (!response.ok) return { ok: false, error: { code: json?.error?.code ?? 'http_error', status: response.status, message: json?.error?.message ?? `HTTP ${response.status}` } }
      return { ok: true, data: json?.data }
    }

    const SETUP_CODES = new Set(['missing_token', 'unauthorized', 'forbidden'])
    const DOWN_CODES = new Set(['unreachable', 'connector_timeout', 'gateway_error', 'network', 'bad_response'])
    const failureText = error => SETUP_CODES.has(error?.code) ? t.failed.setup : DOWN_CODES.has(error?.code) ? t.failed.unreachable : t.failed.other

    const pad = n => String(n).padStart(2, '0')
    const when = iso => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const nameOf = entity => entity?.name ?? t.unnamed
    const radius = entity => 7 + Math.min(entity.score ?? 0, 30) / 3

    const css = {
      root: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' },
      bar: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap', minHeight: 44 },
      title: { fontWeight: 600, fontSize: 15 },
      lead: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', flex: '1 1 auto' },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      button: (active = false, disabled = false) => ({
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 10px', font: 'inherit', fontSize: 12, whiteSpace: 'nowrap',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, color: 'var(--dsw-alias-label-primary)',
        background: active ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
      }),
      input: { font: 'inherit', fontSize: 12, padding: '5px 8px', width: 200, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-bg-base)', color: 'inherit' },
      notice: tone => ({ margin: '10px 16px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        background: tone === 'error' ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)' : tone === 'warn' ? 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent)' : 'var(--dsw-alias-bg-layer-1)' }),
      empty: { padding: '64px 24px', fontSize: 14, lineHeight: 1.6, textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 },
      body: { flex: '1 1 auto', display: 'flex', minHeight: 0, position: 'relative' },
      canvas: { flex: '1 1 auto', minWidth: 0, position: 'relative', overflow: 'hidden' },
      overlay: { position: 'absolute', display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      zoomButton: { width: 28, height: 28, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 15, cursor: 'pointer', lineHeight: 1 },
      dot: color => ({ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: color }),
      side: { width: 360, flex: '0 0 auto', borderLeft: '1px solid var(--dsw-alias-border-l1)', overflow: 'auto', padding: '16px 18px 24px', background: 'var(--dsw-alias-bg-base)' },
      section: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', margin: '18px 0 6px' },
      badge: { fontSize: 11, padding: '1px 7px', borderRadius: 999, whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)', background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)' },
      link: { border: 'none', background: 'transparent', padding: '6px 8px', margin: '0 -8px', borderRadius: 6, font: 'inherit', textAlign: 'left', color: 'inherit', cursor: 'pointer', display: 'block', width: 'calc(100% + 16px)' },
      results: { position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 280, zIndex: 5, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, boxShadow: '0 6px 20px var(--dsw-alias-bg-mask-2)', padding: 4 },
    }

    function Loading() {
      return h('div', { style: css.empty, 'data-state': 'loading' }, t.loading)
    }

    // ── Canvas: SVG with pan, zoom and node dragging ─────────────────────────
    function MapCanvas({ entities, links, positions, selectedId, matchIds, onSelect }) {
      const svgRef = useRef(null)
      const [view, setView] = useState({ k: 1, x: 0, y: 0 })
      const [moved, setMoved] = useState({})
      const drag = useRef(null)
      const [size, setSize] = useState({ w: 1, h: 1 })

      useEffect(() => {
        const el = svgRef.current
        if (el === null) return undefined
        // Keep the drawing centred when the side panel opens or the window changes size.
        const observer = new ResizeObserver(([entry]) => setSize(old => {
          const next = { w: Math.max(entry.contentRect.width, 1), h: Math.max(entry.contentRect.height, 1) }
          setView(v => ({ ...v, x: v.x + (next.w - old.w) / 2, y: v.y + (next.h - old.h) / 2 }))
          return next
        }))
        observer.observe(el)
        return () => observer.disconnect()
      }, [])

      const at = id => moved[id] ?? positions[id]
      const fit = useCallback(() => {
        const points = entities.map(e => positions[e.id]).filter(Boolean)
        if (points.length === 0) return
        const xs = points.map(p => p[0]); const ys = points.map(p => p[1])
        const minX = Math.min(...xs) - 80; const maxX = Math.max(...xs) + 80
        const minY = Math.min(...ys) - 50; const maxY = Math.max(...ys) + 60
        const k = Math.min(size.w / (maxX - minX), size.h / (maxY - minY), 1.6)
        setView({ k, x: size.w / 2 - k * (minX + maxX) / 2, y: size.h / 2 - k * (minY + maxY) / 2 })
      }, [entities, positions, size.w, size.h])
      const fitted = useRef(false)
      useEffect(() => { setMoved({}); fitted.current = false }, [positions])
      // Fit once per drawing (and once the real size is known), not on every resize.
      useEffect(() => {
        if (fitted.current || size.w <= 1) return
        fitted.current = true
        fit()
      }, [fit, size.w])

      const toLocal = (clientX, clientY) => {
        const rect = svgRef.current.getBoundingClientRect()
        return [clientX - rect.left, clientY - rect.top]
      }
      const zoomAt = (factor, cx, cy) => setView(v => {
        const k = Math.min(Math.max(v.k * factor, 0.2), 4)
        const f = k / v.k
        return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f }
      })

      useEffect(() => {
        const el = svgRef.current
        if (el === null) return undefined
        const onWheel = event => {
          event.preventDefault()
          const [cx, cy] = toLocal(event.clientX, event.clientY)
          zoomAt(Math.exp(-event.deltaY * 0.0015), cx, cy)
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      }, [])

      function onPointerDown(event, id) {
        if (event.button !== 0) return
        event.stopPropagation()
        const [px, py] = toLocal(event.clientX, event.clientY)
        drag.current = { id, startX: px, startY: py, view, origin: id === undefined ? null : at(id), travelled: 0 }
        svgRef.current.setPointerCapture(event.pointerId)
      }
      function onPointerMove(event) {
        const d = drag.current
        if (d === null) return
        const [px, py] = toLocal(event.clientX, event.clientY)
        const ddx = px - d.startX; const ddy = py - d.startY
        d.travelled = Math.max(d.travelled, Math.hypot(ddx, ddy))
        if (d.id === undefined) setView({ ...d.view, x: d.view.x + ddx, y: d.view.y + ddy })
        else if (d.travelled > 3) setMoved(m => ({ ...m, [d.id]: [d.origin[0] + ddx / view.k, d.origin[1] + ddy / view.k] }))
      }
      function onPointerUp() {
        const d = drag.current
        drag.current = null
        if (d === null || d.travelled > 3) return
        onSelect(d.id ?? null)
      }

      const neighbours = useMemo(() => {
        const set = new Set()
        if (selectedId === null) return set
        for (const l of links) {
          if (l.source === selectedId) set.add(l.target)
          if (l.target === selectedId) set.add(l.source)
        }
        return set
      }, [links, selectedId])
      const focus = selectedId !== null ? id => id === selectedId || neighbours.has(id) : matchIds !== null ? id => matchIds.has(id) : () => true

      const lineColor = 'var(--dsw-alias-border-l4)'
      return h('div', { style: css.canvas },
        h('svg', {
          ref: svgRef, width: '100%', height: '100%', style: { display: 'block', touchAction: 'none', cursor: drag.current?.id === undefined && drag.current !== null ? 'grabbing' : 'grab', userSelect: 'none' },
          onPointerDown: event => onPointerDown(event, undefined), onPointerMove, onPointerUp, onPointerCancel: () => { drag.current = null },
          'data-map-canvas': entities.length, role: 'img', 'aria-label': t.lead,
        },
        h('g', { transform: `translate(${view.x},${view.y}) scale(${view.k})` },
          links.map(l => {
            const a = at(l.source); const b = at(l.target)
            if (!a || !b) return null
            const lit = selectedId !== null && (l.source === selectedId || l.target === selectedId)
            const dim = !lit && (selectedId !== null || matchIds !== null)
            return h('line', { key: `${l.source}|${l.target}`, x1: a[0], y1: a[1], x2: b[0], y2: b[1],
              style: { stroke: lit ? 'var(--dsw-alias-label-secondary)' : lineColor, strokeWidth: (lit ? 1.8 : 1.1) / Math.sqrt(view.k), opacity: dim ? 0.25 : 1 } })
          }),
          entities.map(e => {
            const p = at(e.id)
            if (!p) return null
            const r = radius(e)
            const selected = e.id === selectedId
            const on = focus(e.id)
            const confirmed = e.analyses.length > 0
            return h('g', {
              key: e.id, transform: `translate(${p[0]},${p[1]})`, style: { cursor: 'pointer', opacity: on ? 1 : 0.28 },
              onPointerDown: event => onPointerDown(event, e.id), 'data-entity': e.id, 'data-entity-name': nameOf(e),
            },
            h('title', null, e.summary ? `${nameOf(e)} — ${e.summary}` : nameOf(e)),
            h('circle', { r: r + 8, style: { fill: 'transparent' } }),
            selected && h('circle', { r: r + 5, style: { fill: 'none', stroke: 'var(--dsw-alias-label-primary)', strokeWidth: 1.6 } }),
            h('circle', { r, style: {
              fill: confirmed ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-bg-layer-2)',
              stroke: confirmed ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)', strokeWidth: 1.4,
            } }),
            h('text', { y: r + 14, textAnchor: 'middle', style: {
              fontSize: 12, fontWeight: selected || e.main ? 600 : 400, fill: 'var(--dsw-alias-label-primary)',
              paintOrder: 'stroke', stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 4, strokeLinejoin: 'round', pointerEvents: 'none',
            } }, nameOf(e)))
          }))),
        h('div', { style: { ...css.overlay, left: 12, bottom: 12 } },
          h('button', { style: css.zoomButton, title: t.zoomIn, 'aria-label': t.zoomIn, onClick: () => zoomAt(1.25, size.w / 2, size.h / 2) }, '+'),
          h('button', { style: css.zoomButton, title: t.zoomOut, 'aria-label': t.zoomOut, onClick: () => zoomAt(0.8, size.w / 2, size.h / 2) }, '−'),
          h('button', { style: { ...css.zoomButton, width: 'auto', padding: '0 8px', fontSize: 12 }, onClick: () => { setMoved({}); fit() } }, t.fit)),
        h('div', { style: { ...css.overlay, right: 12, bottom: 14, flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12, maxWidth: '70%' } },
          h('span', { style: { display: 'inline-flex', gap: 5, alignItems: 'center' } }, h('span', { style: css.dot('var(--dsw-alias-state-success-primary)') }), t.legendConfirmed),
          h('span', { style: { display: 'inline-flex', gap: 5, alignItems: 'center' } }, h('span', { style: { ...css.dot('var(--dsw-alias-bg-layer-2)'), border: '1.4px solid var(--dsw-alias-label-tertiary)' } }), t.legendOther),
          h('span', null, t.legendLine)),
        h('div', { style: { ...css.overlay, left: 12, top: 10 } }, t.hint))
    }

    // ── Side panel for one entity ────────────────────────────────────────────
    function EntityPanel({ id, entity, onSelect, onClose }) {
      const [state, setState] = useState({ id: null, data: null, error: null })
      const [allFields, setAllFields] = useState(false)
      useEffect(() => {
        let live = true
        setState({ id, data: null, error: null }); setAllFields(false)
        api(`api/ontology-map/entity?id=${encodeURIComponent(id)}`).then(result => {
          if (live) setState({ id, data: result.ok ? result.data : null, error: result.ok ? null : result.error })
        })
        return () => { live = false }
      }, [id])
      const data = state.id === id ? state.data : null
      const error = state.id === id ? state.error : null
      const analyses = data?.analyses ?? entity?.analyses ?? []
      const named = (data?.fields ?? []).filter(f => !f.bookkeeping)
      const fields = allFields ? data?.fields ?? [] : named.slice(0, FIELDS_SHOWN)
      const hiddenFields = (data?.fields?.length ?? 0) - fields.length

      return h('aside', { style: css.side, 'data-entity-panel': id },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
          h('div', { style: { flex: '1 1 auto' } },
            h('div', { style: { fontSize: 17, fontWeight: 600, lineHeight: 1.35 } }, data?.name ?? nameOf(entity)),
            analyses.length > 0 && h('span', { style: { ...css.badge, display: 'inline-block', marginTop: 6 } }, t.confirmedCount(analyses.length))),
          h('button', { style: css.button(), onClick: onClose, 'aria-label': t.close }, t.close)),
        error !== null && h('div', { style: { ...css.notice('error'), margin: '12px 0 0' }, 'data-notice': 'entity-error' }, failureText(error) === t.failed.setup ? t.failed.setup : t.entityFailed),
        data === null && error === null && h('div', { style: { ...css.meta, marginTop: 12 } }, t.loading),
        data !== null && h(React.Fragment, null,
          h('p', { style: { fontSize: 13, lineHeight: 1.6, margin: '12px 0 0', color: data.description ? 'inherit' : 'var(--dsw-alias-label-tertiary)' } }, data.description ?? t.noDescription),

          h('div', { style: css.section }, t.fields),
          data.fields_problem !== null && h('div', { style: css.meta }, t.fieldsFailed),
          data.fields_problem === null && data.fields.length === 0 && h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, t.noFields),
          h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 }, 'data-fields': fields.length },
            fields.map((f, i) => h('li', { key: `${f.column}:${i}`, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 } },
              h('div', { style: { fontWeight: 500 } }, f.name ?? t.unnamed),
              f.meaning !== null && h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, lineHeight: 1.5 } }, f.meaning)))),
          (hiddenFields > 0 || allFields) && h('button', { style: { ...css.button(), marginTop: 8 }, onClick: () => setAllFields(v => !v) }, allFields ? t.fewerFields : t.moreFields(data.fields.length)),

          h('div', { style: css.section }, t.connected),
          data.connected.length === 0 ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, t.noConnected)
            : data.connected.map(c => h('button', { key: c.id, style: css.link, onClick: () => onSelect(c.id), 'data-connected': c.id },
              h('div', { style: { fontSize: 13, fontWeight: 500 } }, c.name ?? t.unnamed),
              c.summary && h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, c.summary))),

          h('div', { style: css.section }, t.analyses),
          analyses.length === 0 ? h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' } }, t.noAnalyses)
            : h('ul', { style: { listStyle: 'none', padding: 0, margin: 0 }, 'data-analyses': analyses.length },
              analyses.map(a => h('li', { key: a.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0', fontSize: 13 } },
                h('span', { style: { flex: '1 1 auto' } }, a.name), h('span', { style: css.badge }, t.confirmed)))),

          data.questions.length > 0 && h(React.Fragment, null,
            h('div', { style: css.section }, t.questions),
            h('ul', { style: { margin: 0, paddingLeft: 18, fontSize: 13 } }, data.questions.map((q, i) => h('li', { key: i }, q)))),

          h('details', { style: { marginTop: 20 }, 'data-details': true },
            h('summary', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } }, t.details),
            h('div', { style: { ...css.meta, marginTop: 8, lineHeight: 1.7 } },
              data.source.tables.length > 0 && h('div', null, `${t.sourceTables}: ${data.source.tables.join(', ')}`),
              data.fields.length > 0 && h('div', null, `${t.sourceFields}: `,
                data.fields.filter(f => f.column !== null).map(f => `${f.name ?? t.unnamed} ${f.column}`).join(' · ')))),
          h('div', { style: { ...css.meta, marginTop: 18 } }, t.footnote)))
    }

    // ── Panel ────────────────────────────────────────────────────────────────
    function MapPanel() {
      const [map, setMap] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [showAll, setShowAll] = useState(false)
      const [selectedId, setSelectedId] = useState(null)
      const [query, setQuery] = useState('')
      const [searchOpen, setSearchOpen] = useState(false)

      const load = useCallback(async refresh => {
        setBusy(true)
        const result = await api(`api/ontology-map/graph${refresh ? '?refresh=1' : ''}`)
        setBusy(false)
        if (result.ok) { setMap(result.data); setError(null) } else setError(result.error)
      }, [])
      useEffect(() => { load(false) }, [load])

      const byId = useMemo(() => new Map((map?.entities ?? []).map(e => [e.id, e])), [map])
      const visible = useMemo(() => (map?.entities ?? []).filter(e => showAll || e.main), [map, showAll])
      const visibleIds = useMemo(() => new Set(visible.map(e => e.id)), [visible])
      const visibleLinks = useMemo(() => (map?.links ?? []).filter(l => visibleIds.has(l.source) && visibleIds.has(l.target)), [map, visibleIds])
      const positions = map === null ? {} : showAll ? map.layouts.all : map.layouts.main

      const needle = query.trim().toLowerCase()
      const matches = useMemo(() => {
        if (needle === '' || map === null) return null
        const hit = s => typeof s === 'string' && s.toLowerCase().includes(needle)
        const rank = e => hit(e.name) ? (e.name.toLowerCase().startsWith(needle) ? 0 : 1) : e.aliases.some(hit) ? 2 : 3
        return map.entities.filter(e => [e.name, e.summary, ...e.aliases].some(hit)).map(e => [e, rank(e)]).sort((a, b) => a[1] - b[1]).map(([e]) => e)
      }, [map, needle])
      const matchIds = useMemo(() => matches === null ? null : new Set(matches.map(e => e.id)), [matches])

      const select = id => {
        if (id !== null && !visibleIds.has(id)) setShowAll(true)
        setSelectedId(id)
        setSearchOpen(false)
      }

      const header = h('div', { style: css.bar },
        h('div', { style: css.title }, t.menu),
        h('div', { style: css.lead }, t.lead),
        map !== null && map.entities.length > 0 && h(React.Fragment, null,
          h('div', { style: { position: 'relative' } },
            h('input', {
              type: 'search', value: query, placeholder: t.search, 'aria-label': t.search, style: css.input, 'data-map-search': true,
              onChange: event => { setQuery(event.target.value); setSearchOpen(true) },
              onFocus: () => setSearchOpen(true),
              onKeyDown: event => {
                if (event.key === 'Enter' && matches?.length > 0) select(matches[0].id)
                if (event.key === 'Escape') { setQuery(''); setSearchOpen(false) }
              },
            }),
            searchOpen && matches !== null && h('div', { style: css.results, 'data-search-results': matches.length },
              matches.length === 0 ? h('div', { style: { padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t.noMatch)
                : matches.slice(0, SEARCH_RESULTS).map(e => h('button', { key: e.id, style: { ...css.link, margin: 0, width: '100%' }, onMouseDown: event => event.preventDefault(), onClick: () => select(e.id) },
                  h('div', { style: { fontSize: 13, fontWeight: 500 } }, nameOf(e)),
                  e.summary && h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, e.summary))))),
          map.counts.entities > map.counts.main && h('div', { style: { display: 'inline-flex' }, role: 'group' },
            h('button', { style: { ...css.button(!showAll), borderRadius: '6px 0 0 6px' }, onClick: () => { setShowAll(false); if (selectedId !== null && !byId.get(selectedId)?.main) setSelectedId(null) }, 'data-view': 'main' }, t.mainOnly(map.counts.main)),
            h('button', { style: { ...css.button(showAll), borderRadius: '0 6px 6px 0', borderLeft: 'none' }, onClick: () => setShowAll(true), 'data-view': 'all' }, t.showAll(map.counts.entities)))),
        map !== null && h('button', { style: css.button(false, busy), disabled: busy, onClick: () => load(true), 'data-action': 'reload' }, busy ? t.reloading : t.reload))

      let content
      if (map === null && error === null) content = h(Loading)
      else if (map === null) {
        content = h('div', { style: css.empty, 'data-state': 'error', 'data-error-code': error.code },
          h('div', { style: { maxWidth: 460 } }, failureText(error)),
          h('button', { style: css.button(false, busy), disabled: busy, onClick: () => load(true) }, busy ? t.reloading : t.reload))
      } else if (map.entities.length === 0) {
        content = h('div', { style: css.empty, 'data-state': 'empty' }, h('div', { style: { maxWidth: 460 } }, t.empty))
      } else {
        content = h('div', { style: css.body },
          h(MapCanvas, { entities: visible, links: visibleLinks, positions, selectedId, matchIds, onSelect: select }),
          selectedId !== null && h(EntityPanel, { id: selectedId, entity: byId.get(selectedId), onSelect: select, onClose: () => setSelectedId(null) }))
      }

      return h('div', { style: css.root, 'data-panel': PANEL },
        header,
        map !== null && h('div', { style: { ...css.meta, padding: '6px 16px 0' }, 'data-map-meta': true },
          [t.readOnly, map.read_at ? t.readAt(when(map.read_at)) : null, t.counts(map.counts.entities, map.counts.analyses)].filter(Boolean).join(' · ')),
        map?.stale && h('div', { style: css.notice('warn'), 'data-notice': 'stale' }, t.stale(when(map.read_at))),
        map !== null && map.notices.some(n => n.code === 'analyses_unavailable') && h('div', { style: css.notice('plain'), 'data-notice': 'analyses' }, t.analysesMissing),
        error !== null && map !== null && h('div', { style: css.notice('error'), 'data-notice': 'error' }, failureText(error)),
        content)
    }

    function MapIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('path', { d: 'M5 5.2 11 3.8M4.6 6.4l2.2 4.6M11.2 5.2 9.3 10.6', stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' }),
        h('circle', { cx: 4, cy: 5, r: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 12, cy: 3.6, r: 1.8, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 8, cy: 12.2, r: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, MapPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: -70, label: () => t.menu }, MapIcon))
      },
    }
  },
})

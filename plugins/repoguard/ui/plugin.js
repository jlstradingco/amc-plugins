const amc = window.AgentMC

let currentView = 'dashboard'
let dashboardRefreshInterval = null
let scanPollInterval = null
let sentryConfigured = false

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  const el = document.getElementById(`view-${name}`)
  if (el) {
    el.classList.add('active')
    currentView = name
  }
  // Clear auto-refresh when leaving dashboard
  if (name !== 'dashboard' && dashboardRefreshInterval) {
    clearInterval(dashboardRefreshInterval)
    dashboardRefreshInterval = null
  }
  // Clear scan polling when leaving scan-progress
  if (name !== 'scan-progress' && scanPollInterval) {
    clearInterval(scanPollInterval)
    scanPollInterval = null
  }
}

function timeAgo(isoDate) {
  if (!isoDate) return 'Never'
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then
  if (diffMs < 0) return 'just now'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`

  const months = Math.floor(days / 30)
  return `${months} month${months === 1 ? '' : 's'} ago`
}

function scoreColorClass(score) {
  if (score >= 80) return 'score-good'
  if (score >= 60) return 'score-ok'
  return 'score-bad'
}

function gradeClass(grade) {
  const map = { A: 'grade-a', B: 'grade-b', C: 'grade-c', D: 'grade-d', F: 'grade-f' }
  return map[grade] || 'grade-f'
}

function trendHtml(trend) {
  if (trend === 'up') return '<span class="trend-up">&#8593;</span>'
  if (trend === 'down') return '<span class="trend-down">&#8595;</span>'
  return '<span class="trend-stable">&#8212;</span>'
}

async function loadDashboard() {
  showView('dashboard')
  const container = document.getElementById('view-dashboard')

  let projects = []
  try {
    projects = await amc.scan.listProjectsWithScores()
  } catch (err) {
    container.innerHTML = `
      <div class="header">
        <h1>RepoGuard</h1>
        <p class="subtitle">Repo health scoring &amp; security scanning</p>
      </div>
      <div class="empty-state">
        <h3>Failed to load projects</h3>
        <p>${err.message || 'Unknown error'}</p>
      </div>
    `
    return
  }

  // Push project data to AMC sidebar panel
  pushSidebarItems(projects)

  // Check Sentry configuration status
  sentryConfigured = false
  try {
    const token = await amc.settings.get('sentryAuthToken')
    const org = await amc.settings.get('sentryOrgSlug')
    sentryConfigured = !!(token && org)
  } catch (_err) {
    // Settings not available — treat as not configured
  }

  // Build fleet health summary from scanned projects
  const scanned = projects.filter(p => p.score != null && p.status === 'completed')
  let fleetHealthHtml = ''
  if (scanned.length > 0) {
    const avgScore = Math.round(scanned.reduce((sum, p) => sum + p.score, 0) / scanned.length)
    const fleetGrade = avgScore >= 90 ? 'A' : avgScore >= 80 ? 'B' : avgScore >= 70 ? 'C' : avgScore >= 60 ? 'D' : 'F'
    fleetHealthHtml = `
      <div class="fleet-health-card">
        <div class="fleet-score">
          <span class="score-big">${avgScore}</span>
          <span class="grade-badge grade-badge-lg ${gradeClass(fleetGrade)}">${fleetGrade}</span>
        </div>
        <div class="fleet-meta">
          <span>Fleet Health</span>
          <span class="text-muted">${scanned.length} of ${projects.length} project${projects.length === 1 ? '' : 's'} scanned</span>
        </div>
      </div>
    `
  }

  // Build table rows
  let tableHtml = ''
  if (projects.length === 0) {
    tableHtml = `
      <div class="empty-state">
        <h3>No projects configured in AMC</h3>
        <p>Add a project in Agent Mission Control to start scanning.</p>
      </div>
    `
  } else {
    const rows = projects.map(p => {
      if (p.score == null || !p.status || p.status !== 'completed') {
        // Unscanned project
        return `
          <tr onclick="openProjectDetail('${p.projectId}')" class="clickable-row">
            <td>
              <div class="project-name">${escapeHtml(p.projectName)}</div>
              <div class="project-path text-muted">${escapeHtml(p.folderPath || '')}</div>
            </td>
            <td><span class="not-scanned">--</span></td>
            <td><span class="not-scanned">--</span></td>
            <td class="text-muted">Not scanned</td>
            <td><span class="trend-stable">--</span></td>
            <td class="actions-cell">
              <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); startScan('${p.projectId}', 'full')">Run First Scan</button>
            </td>
          </tr>
        `
      }
      return `
        <tr onclick="openProjectDetail('${p.projectId}')" class="clickable-row">
          <td>
            <div class="project-name">${escapeHtml(p.projectName)}</div>
            <div class="project-path text-muted">${escapeHtml(p.folderPath || '')}</div>
          </td>
          <td><span class="score-cell ${scoreColorClass(p.score)}">${p.score}</span></td>
          <td><span class="grade-badge ${gradeClass(p.grade)}">${p.grade}</span></td>
          <td class="text-muted">${timeAgo(p.scannedAt)}</td>
          <td>${trendHtml(p.trend)}</td>
          <td class="actions-cell">
            <button class="btn btn-sm" onclick="event.stopPropagation(); startScan('${p.projectId}', 'quick')">Quick</button>
            <button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); startScan('${p.projectId}', 'full')">Full</button>
          </td>
        </tr>
      `
    }).join('')

    tableHtml = `
      <table class="projects-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Score</th>
            <th>Grade</th>
            <th>Last Scan</th>
            <th>Trend</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `
  }

  container.innerHTML = `
    <div class="header">
      <h1>RepoGuard</h1>
      <p class="subtitle">Repo health scoring &amp; security scanning</p>
    </div>
    ${!sentryConfigured ? `
      <div class="sentry-banner">
        <span class="sentry-banner-icon">&#9432;</span>
        Using Sentry to monitor your deployed apps? Add your auth token in RepoGuard settings to include runtime error data in scans.
      </div>
    ` : ''}
    ${fleetHealthHtml}
    <div class="adhoc-bar">
      <input type="text" id="adhoc-url" placeholder="Paste GitHub URL to scan any repo..." class="input-field">
      <button onclick="startAdhocScan()" class="btn btn-primary">Scan</button>
    </div>
    ${tableHtml}
  `

  // Set up auto-refresh every 30 seconds
  if (dashboardRefreshInterval) {
    clearInterval(dashboardRefreshInterval)
  }
  dashboardRefreshInterval = setInterval(() => {
    if (currentView === 'dashboard') {
      loadDashboard()
    }
  }, 30000)
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// ── Project Detail View ──────────────────────────────

const CATEGORY_NAMES = {
  sast: 'Security (SAST)',
  secrets: 'Secrets Exposure',
  sca: 'Dependencies (SCA)',
  quality: 'Code Quality',
  config: 'CI/CD & Config',
  container: 'Container Security',
  runtime: 'Runtime Health'
}

const PRIORITY_LABELS = {
  'fix-now': 'Fix Now',
  'plan-fix': 'Plan Fix',
  'improve': 'Improve',
  'nice-to-have': 'Nice to Have'
}

let currentFindings = []
let currentScanId = null

async function openProjectDetail(projectId) {
  showView('project-detail')
  const container = document.getElementById('view-project-detail')
  if (!container) return

  // Show loading state
  container.innerHTML = `
    <div class="detail-header">
      <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
    </div>
    <div class="empty-state">
      <div class="skeleton skeleton-text" style="width:200px;height:20px"></div>
      <div class="skeleton skeleton-text" style="width:160px;height:14px;margin-top:8px"></div>
    </div>
  `

  // Fetch project info
  let projects = []
  try {
    projects = await amc.scan.listProjectsWithScores()
  } catch (err) {
    container.innerHTML = `
      <div class="detail-header">
        <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
      </div>
      <div class="empty-state">
        <h3>Failed to load project</h3>
        <p>${escapeHtml(err.message || 'Unknown error')}</p>
        <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
      </div>
    `
    return
  }

  const project = projects.find(p => p.projectId === projectId)
  if (!project) {
    container.innerHTML = `
      <div class="detail-header">
        <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
      </div>
      <div class="empty-state">
        <h3>Project not found</h3>
        <p>Could not find a project with the given ID.</p>
        <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
      </div>
    `
    return
  }

  const { projectName, folderPath, lastScanId, score, grade, scannedAt, trend } = project

  // No scan yet — show empty state with scan button
  if (!lastScanId) {
    container.innerHTML = `
      <div class="detail-header">
        <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
        <div class="detail-hero">
          <div class="hero-meta">
            <h2>${escapeHtml(projectName || '')}</h2>
            <p class="text-muted">${escapeHtml(folderPath || '')}</p>
          </div>
        </div>
      </div>
      <div class="empty-state">
        <h3>No scans yet</h3>
        <p>Run your first scan to get a health score and security findings.</p>
        <button class="btn btn-primary" onclick="startScan('${escapeHtml(projectId)}', 'full')">Run First Scan</button>
      </div>
    `
    return
  }

  // Fetch scan detail + findings in parallel
  let scanDetail = null
  let findings = []
  try {
    const [detailResult, findingsResult] = await Promise.all([
      amc.scan.getScanDetail(lastScanId),
      amc.scan.getFindings(lastScanId)
    ])
    scanDetail = detailResult
    findings = findingsResult || []
  } catch (err) {
    container.innerHTML = `
      <div class="detail-header">
        <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
        <div class="detail-hero">
          <div class="hero-meta">
            <h2>${escapeHtml(projectName || '')}</h2>
            <p class="text-muted">${escapeHtml(folderPath || '')}</p>
          </div>
        </div>
      </div>
      <div class="empty-state">
        <h3>Failed to load scan data</h3>
        <p>${escapeHtml(err.message || 'Unknown error')}</p>
        <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
      </div>
    `
    return
  }

  // Store for filtering
  currentFindings = findings
  currentScanId = lastScanId

  const scanType = scanDetail?.scan?.scan_type || 'unknown'
  const categoryScores = scanDetail?.categoryScores || []

  // Build category cards
  const categoryCardsHtml = categoryScores.map(cat => {
    const catName = CATEGORY_NAMES[cat.category] || escapeHtml(cat.category || 'Unknown')
    const catGrade = cat.grade || '--'
    const catScore = cat.score != null ? cat.score : '--'
    const findingCount = cat.finding_count || 0
    const skipped = cat.skipped
    const summary = cat.summary ? escapeHtml(cat.summary) : ''

    return `
      <div class="category-card ${skipped ? 'category-skipped' : ''}">
        <div class="category-card-header">
          <span class="category-name">${catName}</span>
          <span class="grade-badge ${gradeClass(catGrade)}">${escapeHtml(String(catGrade))}</span>
        </div>
        <div class="category-score ${scoreColorClass(typeof catScore === 'number' ? catScore : 0)}">${catScore}/100</div>
        ${summary ? `<div class="category-summary text-muted">${summary}</div>` : ''}
        <div class="category-findings-count">${findingCount} finding${findingCount === 1 ? '' : 's'}</div>
      </div>
    `
  }).join('')

  // Build Sentry section
  let sentrySectionHtml = ''
  if (sentryConfigured) {
    let sentryProjects = []
    let currentOverride = null
    try {
      const [projectsResult, overrideResult] = await Promise.all([
        amc.scan.listSentryProjects(),
        amc.scan.getSentryOverride(projectId)
      ])
      sentryProjects = projectsResult?.projects || []
      currentOverride = overrideResult
    } catch (_err) {
      // Sentry API might fail — show section with error
    }

    const optionsHtml = sentryProjects
      .map(p => {
        const selected = currentOverride === p.slug ? 'selected' : ''
        return `<option value="${escapeHtml(p.slug)}" ${selected}>${escapeHtml(p.name)} (${escapeHtml(p.slug)})</option>`
      })
      .join('')

    const autoSelected = !currentOverride ? 'selected' : ''
    const autoMatchStatus = !currentOverride
      ? sentryProjects.find(p => p.slug === normalizeName(projectName))
        ? 'Matched'
        : 'No match'
      : ''

    sentrySectionHtml = `
      <div class="sentry-section">
        <h3>Runtime Monitoring</h3>
        <div class="sentry-config">
          <label class="text-muted">Sentry Project:</label>
          <select id="sentry-project-select" class="input-field" onchange="handleSentryOverrideChange('${escapeHtml(projectId)}', this.value)">
            <option value="" ${autoSelected}>Auto-detect${autoMatchStatus ? ` (${autoMatchStatus})` : ''}</option>
            ${optionsHtml}
          </select>
        </div>
      </div>
    `
  } else {
    sentrySectionHtml = `
      <div class="sentry-section sentry-not-configured">
        <h3>Runtime Monitoring</h3>
        <p class="text-muted">Not configured. Add your Sentry auth token in RepoGuard settings to monitor runtime errors.</p>
      </div>
    `
  }

  // Build unique category list for filter dropdown
  const uniqueCategories = [...new Set(findings.map(f => f.category).filter(Boolean))]
  const categoryOptionsHtml = uniqueCategories.map(c => {
    const label = CATEGORY_NAMES[c] || escapeHtml(c)
    return `<option value="${escapeHtml(c)}">${label}</option>`
  }).join('')

  // Render the full detail view
  container.innerHTML = `
    <div class="detail-header">
      <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
      <div class="detail-hero">
        <div class="hero-score">
          <span class="score-big ${scoreColorClass(score || 0)}">${score != null ? score : '--'}</span>
          <span class="grade-badge grade-badge-lg ${gradeClass(grade || 'F')}">${escapeHtml(grade || '--')}</span>
        </div>
        <div class="hero-meta">
          <h2>${escapeHtml(projectName || '')}</h2>
          <p class="text-muted">${escapeHtml(folderPath || '')}</p>
          <p class="text-muted">Last scan: ${timeAgo(scannedAt)} &middot; ${escapeHtml(scanType)}</p>
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn btn-sm" onclick="startScan('${escapeHtml(projectId)}', 'quick')">Quick Scan</button>
        <button class="btn btn-sm btn-outline" onclick="startScan('${escapeHtml(projectId)}', 'full')">Full Audit</button>
        <button class="btn btn-sm btn-outline" onclick="exportReport('${escapeHtml(lastScanId)}', 'markdown')">Export MD</button>
      </div>
    </div>

    <div class="category-grid">
      ${categoryCardsHtml}
    </div>

    ${sentrySectionHtml}

    <div class="findings-section">
      <div class="findings-header">
        <h3>Findings (${findings.length})</h3>
        <div class="findings-filters">
          <select id="filter-category" class="input-field" onchange="filterFindings()">
            <option value="">All Categories</option>
            ${categoryOptionsHtml}
          </select>
          <select id="filter-severity" class="input-field" onchange="filterFindings()">
            <option value="">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <div id="findings-list">
      </div>
    </div>
  `

  // Render initial findings list
  renderFindings(findings)
}

function renderFindings(findings) {
  const listEl = document.getElementById('findings-list')
  if (!listEl) return

  if (!findings || findings.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state" style="padding:24px 0">
        <p>No findings match the current filters.</p>
      </div>
    `
    return
  }

  // Sort: critical first, then high, medium, low; within same severity by priority
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  const priorityOrder = { 'fix-now': 0, 'plan-fix': 1, 'improve': 2, 'nice-to-have': 3 }

  const sorted = [...findings].sort((a, b) => {
    const sa = severityOrder[a.severity] ?? 99
    const sb = severityOrder[b.severity] ?? 99
    if (sa !== sb) return sa - sb
    const pa = priorityOrder[a.remediation_priority] ?? 99
    const pb = priorityOrder[b.remediation_priority] ?? 99
    return pa - pb
  })

  listEl.innerHTML = sorted.map(f => {
    const severity = escapeHtml(f.severity || 'info')
    const priority = f.remediation_priority || ''
    const priorityLabel = PRIORITY_LABELS[priority] || ''
    const title = escapeHtml(f.title || 'Untitled finding')
    const filePath = f.file_path ? escapeHtml(f.file_path) : ''
    const lineRange = f.line_start ? (f.line_end && f.line_end !== f.line_start ? `:${f.line_start}-${f.line_end}` : `:${f.line_start}`) : ''
    const description = f.description ? escapeHtml(f.description) : ''
    const codebaseContext = f.codebase_context ? escapeHtml(f.codebase_context) : ''
    const fixSuggestion = f.fix_suggestion ? escapeHtml(f.fix_suggestion) : ''
    const fixSnippet = f.fix_snippet ? escapeHtml(f.fix_snippet) : ''
    const referenceUrl = f.reference_url || ''
    const isResolved = f.status === 'resolved'
    const findingId = f.id || ''

    return `
      <div class="finding-row ${isResolved ? 'finding-resolved' : ''}" onclick="toggleFinding(this)">
        <div class="finding-summary">
          <span class="severity-badge severity-${severity}">${severity}</span>
          ${priorityLabel ? `<span class="priority-label priority-${escapeHtml(priority)}">${escapeHtml(priorityLabel)}</span>` : ''}
          <span class="finding-title">${title}</span>
          ${filePath ? `<span class="finding-file text-muted">${filePath}${lineRange}</span>` : ''}
        </div>
        <div class="finding-detail" style="display:none">
          ${description ? `<p class="finding-description">${description}</p>` : ''}
          ${codebaseContext ? `<div class="finding-context"><strong>Analysis:</strong> ${codebaseContext}</div>` : ''}
          ${fixSuggestion ? `<div class="finding-fix"><strong>Fix:</strong> ${fixSuggestion}</div>` : ''}
          ${fixSnippet ? `<pre class="finding-snippet"><code>${fixSnippet}</code></pre>` : ''}
          ${referenceUrl ? `<a href="${escapeHtml(referenceUrl)}" class="finding-link" target="_blank" rel="noopener noreferrer">Reference</a>` : ''}
          ${isResolved
            ? `<button class="btn btn-sm btn-outline" disabled>Resolved</button>`
            : `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); resolveFindingAction('${escapeHtml(findingId)}', this)">Mark Resolved</button>`
          }
        </div>
      </div>
    `
  }).join('')
}

function toggleFinding(el) {
  const detail = el.querySelector('.finding-detail')
  if (detail) {
    detail.style.display = detail.style.display === 'none' ? 'block' : 'none'
  }
}

function filterFindings() {
  const category = document.getElementById('filter-category')?.value || ''
  const severity = document.getElementById('filter-severity')?.value || ''
  let filtered = currentFindings
  if (category) filtered = filtered.filter(f => f.category === category)
  if (severity) filtered = filtered.filter(f => f.severity === severity)

  // Update count in header
  const headerH3 = document.querySelector('.findings-header h3')
  if (headerH3) {
    headerH3.textContent = `Findings (${filtered.length})`
  }

  renderFindings(filtered)
}

async function resolveFindingAction(findingId, btn) {
  if (!findingId) return
  try {
    btn.textContent = 'Resolving...'
    btn.disabled = true
    await amc.scan.resolveFinding(findingId)
    const row = btn.closest('.finding-row')
    if (row) {
      row.classList.add('finding-resolved')
    }
    btn.textContent = 'Resolved'
    // Update the finding status in the cached list
    const found = currentFindings.find(f => f.id === findingId)
    if (found) found.status = 'resolved'
  } catch (err) {
    btn.textContent = 'Error'
    btn.disabled = false
  }
}

async function exportReport(scanId, format) {
  try {
    const result = await amc.scan.exportReport(scanId, format)
    if (result?.ok && result?.content) {
      await navigator.clipboard.writeText(result.content)
      const toast = document.createElement('div')
      toast.className = 'toast'
      toast.textContent = 'Report copied to clipboard!'
      document.body.appendChild(toast)
      setTimeout(() => toast.remove(), 3000)
    }
  } catch (err) {
    const toast = document.createElement('div')
    toast.className = 'toast toast-error'
    toast.textContent = 'Export failed'
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  }
}

const FULL_SCAN_AGENTS = ['sast', 'secrets', 'sca', 'quality', 'config', 'container', 'runtime']
const QUICK_SCAN_AGENTS = ['secrets', 'sca', 'quality']

function showScanProgress(scanId, title, subtitle, projectId, agentList) {
  const container = document.getElementById('view-scan-progress')
  if (!container) return

  // Build agent status rows
  const agentRowsHtml = agentList.map(agent => {
    const name = CATEGORY_NAMES[agent] || escapeHtml(agent)
    return `
      <div class="agent-status-row" data-agent="${escapeHtml(agent)}">
        <span class="agent-status-icon status-pending">&#9679;</span>
        <span class="agent-status-name">${name}</span>
        <span class="agent-status-text text-muted">Waiting</span>
      </div>
    `
  }).join('')

  container.innerHTML = `
    <div class="progress-container">
      <div class="progress-header">
        <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
        <div class="progress-title">${escapeHtml(title)}</div>
        <div class="progress-subtitle text-muted">${escapeHtml(subtitle)}</div>
      </div>

      <div class="progress-overall">
        <div class="progress-bar">
          <div class="progress-fill" id="scan-progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-label text-muted" id="scan-progress-label">Starting scan...</div>
      </div>

      <div class="agent-status-list" id="agent-status-list">
        ${agentRowsHtml}
      </div>
    </div>
  `

  // Mark the first agent as running
  const firstRow = container.querySelector('.agent-status-row')
  if (firstRow) {
    const icon = firstRow.querySelector('.agent-status-icon')
    const text = firstRow.querySelector('.agent-status-text')
    if (icon) { icon.className = 'agent-status-icon status-running'; icon.innerHTML = '&#9679;' }
    if (text) text.textContent = 'Running...'
  }

  // Clear any existing poll
  if (scanPollInterval) {
    clearInterval(scanPollInterval)
    scanPollInterval = null
  }

  let pollCount = 0
  const maxPolls = 100 // 5 minutes at 3s intervals

  scanPollInterval = setInterval(async () => {
    pollCount++
    if (pollCount > maxPolls) {
      clearInterval(scanPollInterval)
      scanPollInterval = null
      updateProgressLabel('Scan timed out (5 min limit). Check dashboard for results.')
      return
    }

    // Don't poll if we navigated away
    if (currentView !== 'scan-progress') {
      clearInterval(scanPollInterval)
      scanPollInterval = null
      return
    }

    try {
      const detail = await amc.scan.getScanDetail(scanId)
      if (!detail || !detail.scan) return

      const scan = detail.scan
      const categoryScores = detail.categoryScores || []
      const completedCategories = categoryScores.map(cs => cs.category)
      const totalAgents = agentList.length
      const completedCount = completedCategories.filter(c => agentList.includes(c)).length
      const pct = totalAgents > 0 ? Math.round((completedCount / totalAgents) * 100) : 0

      // Update progress bar
      const progressBar = document.getElementById('scan-progress-bar')
      if (progressBar) progressBar.style.width = pct + '%'

      // Update agent rows
      agentList.forEach(agent => {
        const row = container.querySelector(`.agent-status-row[data-agent="${agent}"]`)
        if (!row) return
        const icon = row.querySelector('.agent-status-icon')
        const text = row.querySelector('.agent-status-text')
        const catScore = categoryScores.find(cs => cs.category === agent)

        if (catScore) {
          // Completed
          if (catScore.skipped) {
            if (icon) { icon.className = 'agent-status-icon status-skipped'; icon.innerHTML = '&mdash;' }
            if (text) text.textContent = 'Skipped'
          } else {
            if (icon) { icon.className = 'agent-status-icon status-completed'; icon.innerHTML = '&#10003;' }
            if (text) text.textContent = catScore.score != null ? `${catScore.score}/100` : 'Done'
          }
        } else if (completedCount > 0) {
          // If some agents have completed but this one hasn't, mark next pending as running
          const firstPending = agentList.find(a => !completedCategories.includes(a))
          if (agent === firstPending) {
            if (icon) { icon.className = 'agent-status-icon status-running'; icon.innerHTML = '&#9679;' }
            if (text) text.textContent = 'Running...'
          }
        }
      })

      if (scan.status === 'completed') {
        clearInterval(scanPollInterval)
        scanPollInterval = null

        // Update progress to 100%
        if (progressBar) progressBar.style.width = '100%'
        updateProgressLabel('Scan complete!')

        // Mark all remaining as completed
        agentList.forEach(agent => {
          const row = container.querySelector(`.agent-status-row[data-agent="${agent}"]`)
          if (!row) return
          const icon = row.querySelector('.agent-status-icon')
          const text = row.querySelector('.agent-status-text')
          const catScore = categoryScores.find(cs => cs.category === agent)
          if (!catScore) {
            if (icon) { icon.className = 'agent-status-icon status-skipped'; icon.innerHTML = '&mdash;' }
            if (text) text.textContent = 'Skipped'
          }
        })

        // Show completion hero
        const score = scan.score != null ? scan.score : '--'
        const grade = scan.grade || '--'
        const heroHtml = `
          <div class="scan-complete-hero">
            <span class="score-big ${scoreColorClass(typeof score === 'number' ? score : 0)}">${score}</span>
            <span class="grade-badge grade-badge-lg ${gradeClass(grade)}">${escapeHtml(String(grade))}</span>
            <div class="scan-complete-actions">
              ${projectId ? `<button class="btn btn-primary" onclick="openProjectDetail('${escapeHtml(projectId)}')">View Results</button>` : ''}
              <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
            </div>
          </div>
        `
        const statusList = document.getElementById('agent-status-list')
        if (statusList) statusList.insertAdjacentHTML('afterend', heroHtml)

        // Auto-navigate after 3 seconds if projectId available
        if (projectId) {
          setTimeout(() => {
            if (currentView === 'scan-progress') {
              openProjectDetail(projectId)
            }
          }, 3000)
        }
        return
      }

      if (scan.status === 'failed') {
        clearInterval(scanPollInterval)
        scanPollInterval = null

        updateProgressLabel('Scan failed')

        // Mark remaining agents as failed
        agentList.forEach(agent => {
          const row = container.querySelector(`.agent-status-row[data-agent="${agent}"]`)
          if (!row) return
          const icon = row.querySelector('.agent-status-icon')
          const text = row.querySelector('.agent-status-text')
          const catScore = categoryScores.find(cs => cs.category === agent)
          if (!catScore) {
            if (icon) { icon.className = 'agent-status-icon status-failed'; icon.innerHTML = '&#10007;' }
            if (text) text.textContent = 'Failed'
          }
        })

        const statusList = document.getElementById('agent-status-list')
        if (statusList) {
          statusList.insertAdjacentHTML('afterend', `
            <div class="scan-complete-hero">
              <div style="color: var(--rg-grade-f); font-weight: 600; font-size: 16px;">Scan Failed</div>
              <div class="scan-complete-actions">
                <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
              </div>
            </div>
          `)
        }
        return
      }

      // Still running
      updateProgressLabel(`Scanning... ${completedCount} of ${totalAgents} agents complete (${pct}%)`)

    } catch (_err) {
      // Silently continue polling — transient errors shouldn't stop progress
    }
  }, 3000)
}

function updateProgressLabel(text) {
  const label = document.getElementById('scan-progress-label')
  if (label) label.textContent = text
}

async function startScan(projectId, scanType) {
  showView('scan-progress')
  const container = document.getElementById('view-scan-progress')

  // Determine agent list based on scan type
  const agentList = scanType === 'full' ? FULL_SCAN_AGENTS : QUICK_SCAN_AGENTS
  const title = scanType === 'full' ? 'Full Audit' : 'Quick Scan'

  // Try to get the project name for a better subtitle
  let subtitle = projectId || ''
  try {
    const projects = await amc.scan.listProjectsWithScores()
    const project = projects.find(p => p.projectId === projectId)
    if (project) subtitle = project.projectName || project.folderPath || projectId
  } catch (_err) {
    // Use projectId as fallback
  }

  // Show initial indeterminate progress while kicking off the scan
  if (container) {
    container.innerHTML = `
      <div class="progress-container">
        <div class="progress-header">
          <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
          <div class="progress-title">${escapeHtml(title)}</div>
          <div class="progress-subtitle text-muted">${escapeHtml(subtitle)}</div>
        </div>
        <div class="progress-overall">
          <div class="progress-bar">
            <div class="progress-fill indeterminate"></div>
          </div>
          <div class="progress-label text-muted">Starting scan...</div>
        </div>
      </div>
    `
  }

  try {
    const result = await amc.scan.startScan({ projectId, scanType })
    if (!result?.scanId) {
      if (container) {
        container.innerHTML = `
          <div class="progress-container">
            <div class="progress-header">
              <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
              <div class="progress-title">Scan Error</div>
              <div class="progress-subtitle text-muted">No scan ID returned</div>
            </div>
            <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
          </div>
        `
      }
      return
    }
    showScanProgress(result.scanId, title, subtitle, projectId, agentList)
  } catch (err) {
    if (container) {
      container.innerHTML = `
        <div class="progress-container">
          <div class="progress-header">
            <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
            <div class="progress-title">Scan failed</div>
            <div class="progress-subtitle text-muted">${escapeHtml(err.message || 'Unknown error')}</div>
          </div>
          <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
        </div>
      `
    }
  }
}

async function startAdhocScan() {
  const urlInput = document.getElementById('adhoc-url')
  const url = urlInput?.value?.trim()
  if (!url) return

  showView('scan-progress')
  const container = document.getElementById('view-scan-progress')
  const agentList = FULL_SCAN_AGENTS
  const title = 'Full Audit'
  const subtitle = url

  // Show initial indeterminate progress while kicking off the scan
  if (container) {
    container.innerHTML = `
      <div class="progress-container">
        <div class="progress-header">
          <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
          <div class="progress-title">${escapeHtml(title)}</div>
          <div class="progress-subtitle text-muted">${escapeHtml(subtitle)}</div>
        </div>
        <div class="progress-overall">
          <div class="progress-bar">
            <div class="progress-fill indeterminate"></div>
          </div>
          <div class="progress-label text-muted">Starting scan...</div>
        </div>
      </div>
    `
  }

  try {
    const result = await amc.scan.startScan({ repoUrl: url, scanType: 'full' })
    if (!result?.scanId) {
      if (container) {
        container.innerHTML = `
          <div class="progress-container">
            <div class="progress-header">
              <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
              <div class="progress-title">Scan Error</div>
              <div class="progress-subtitle text-muted">No scan ID returned</div>
            </div>
            <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
          </div>
        `
      }
      return
    }
    // No projectId for ad-hoc scans
    showScanProgress(result.scanId, title, subtitle, null, agentList)
  } catch (err) {
    if (container) {
      container.innerHTML = `
        <div class="progress-container">
          <div class="progress-header">
            <button class="btn btn-text" onclick="loadDashboard()">&larr; Back</button>
            <div class="progress-title">Scan failed</div>
            <div class="progress-subtitle text-muted">${escapeHtml(err.message || 'Unknown error')}</div>
          </div>
          <button class="btn btn-secondary" onclick="loadDashboard()">Back to Dashboard</button>
        </div>
      `
    }
  }
}

// Push sidebar items showing project health to the AMC second panel
function pushSidebarItems(projects) {
  if (!amc?.sidebar?.setItems) return

  const items = projects.map(p => {
    const hasScore = p.score != null && p.status === 'completed'
    const grade = hasScore ? p.grade : null
    const statusLabel = hasScore
      ? `${p.grade} — ${p.score}/100`
      : 'Not scanned'

    return {
      id: p.projectId,
      title: p.projectName || p.folderPath || p.projectId,
      status: hasScore ? 'scanned' : 'not_scanned',
      needsYou: hasScore && p.score < 60,
      progress: hasScore ? p.score : undefined
    }
  })

  amc.sidebar.setItems(items)
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadDashboard()
})

// Navigation hooks for sidebar and onclick handlers
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

async function handleSentryOverrideChange(projectId, slug) {
  try {
    await amc.scan.setSentryOverride(projectId, slug || null)
    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.textContent = slug ? `Sentry project set to ${slug}` : 'Reset to auto-detect'
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  } catch (err) {
    const toast = document.createElement('div')
    toast.className = 'toast toast-error'
    toast.textContent = 'Failed to update Sentry override'
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  }
}

window.handleSentryOverrideChange = handleSentryOverrideChange
window.openProjectDetail = openProjectDetail
window.loadDashboard = loadDashboard
window.startScan = startScan
window.startAdhocScan = startAdhocScan
window.showScanProgress = showScanProgress
window.toggleFinding = toggleFinding
window.filterFindings = filterFindings
window.resolveFindingAction = resolveFindingAction
window.exportReport = exportReport

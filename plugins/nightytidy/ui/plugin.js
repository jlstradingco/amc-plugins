const amc = window.AgentMC

let currentView = 'dashboard'
let state = {
  projects: [],
  selectedProjectId: null,
  runs: [],
  steps: [],
  activeRun: null,
  activeRunSteps: [],
  selectedStepIds: new Set(),
  presets: [],
  schedules: [],
  settings: {},
  stepsLoaded: false
}

// ====== NAVIGATION ======

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  const el = document.getElementById('view-' + name)
  if (el) { el.classList.add('active'); currentView = name }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === name)
  })
  if (name === 'dashboard') loadDashboard()
  else if (name === 'settings') loadSettings()
}

function renderTabBar() {
  const tabs = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'live-run', label: 'Live Run' },
    { id: 'results', label: 'Results' },
    { id: 'settings', label: 'Settings' }
  ]
  document.getElementById('tab-bar').innerHTML = tabs
    .map(t => `<button class="tab-btn ${t.id === currentView ? 'active' : ''}" data-view="${t.id}" onclick="showView('${t.id}')">${t.label}</button>`)
    .join('')
}

function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// ====== HELPERS ======

function statusBadge(status) {
  const map = {
    completed: { class: 'badge-success', label: 'PASSED' },
    failed: { class: 'badge-error', label: 'FAILED' },
    partial: { class: 'badge-warning', label: 'PARTIAL' },
    cancelled: { class: 'badge-muted', label: 'CANCELLED' },
    running: { class: 'badge-info', label: 'RUNNING' }
  }
  const m = map[status] || { class: 'badge-muted', label: (status || '').toUpperCase() }
  return `<span class="badge ${m.class}">${m.label}</span>`
}

function formatDurationShort(seconds) {
  if (!seconds) return '\u2014'
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

const CATEGORY_COLORS = {
  documentation: '#3b82f6', testing: '#22c55e', security: '#ef4444',
  performance: '#f59e0b', architecture: '#8b5cf6', ux: '#ec4899',
  infrastructure: '#06b6d4', product: '#f97316',
  api: '#6366f1', dependencies: '#14b8a6',
  'code quality': '#a855f7', runtime: '#f43f5e',
  bugs: '#dc2626', frontend: '#ec4899',
  operations: '#0ea5e9', strategy: '#eab308'
}

const CATEGORY_LABELS = {
  documentation: 'Documentation', testing: 'Testing', security: 'Security',
  performance: 'Performance', architecture: 'Architecture', ux: 'UX',
  infrastructure: 'Infrastructure', product: 'Product',
  api: 'API', dependencies: 'Dependencies',
  'code quality': 'Code Quality', runtime: 'Runtime',
  bugs: 'Bugs', frontend: 'Frontend',
  operations: 'Operations', strategy: 'Strategy'
}

// ====== PROJECT SELECTOR ======

async function loadProjects() {
  try {
    const projects = await amc.project.listAll()
    state.projects = projects.filter(p => !p.folderPath.startsWith('__'))
  } catch (err) {
    console.error('[NightyTidy] Failed to load projects:', err)
    state.projects = []
  }
}

function renderProjectSelector() {
  if (state.projects.length === 0) return '<p style="color:var(--text-muted)">No projects found</p>'
  return `<div class="form-group" style="margin-bottom:12px">
    <label class="form-label">Target Project</label>
    <select id="project-select" onchange="onProjectChange(this.value)">
      <option value="">Select a project...</option>
      ${state.projects.map(p =>
        `<option value="${p.id}" ${p.id === state.selectedProjectId ? 'selected' : ''}>${escapeHtml(p.name)} \u2014 ${escapeHtml(p.folderPath)}</option>`
      ).join('')}
    </select>
  </div>`
}

// ====== STEP CHECKLIST (inline on dashboard) ======

function renderStepChecklist() {
  const enabledSteps = state.steps.filter(s => s.enabled)
  if (enabledSteps.length === 0) return '<p style="color:var(--text-muted)">No steps available.</p>'

  const groups = {}
  for (const step of enabledSteps) {
    const cat = step.category || 'other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(step)
  }

  const selectedCount = state.selectedStepIds.size
  const totalEnabled = enabledSteps.length

  let html = `<div class="selection-bar">
    <div class="count">${selectedCount} / ${totalEnabled} steps selected</div>
    <div class="actions">
      <button class="btn-secondary" style="padding:4px 12px;font-size:12px" onclick="selectAllSteps()">All</button>
      <button class="btn-secondary" style="padding:4px 12px;font-size:12px" onclick="selectNoSteps()">None</button>
      <select id="preset-select" onchange="loadPreset(this.value)" style="width:160px;padding:4px 8px;font-size:12px">
        <option value="">Load preset...</option>
        <option value="__all__">Full Audit (${totalEnabled})</option>
        <option value="__quick__">Quick Sweep (10)</option>
        ${state.presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
      </select>
      <button class="btn-secondary" style="padding:4px 12px;font-size:12px" onclick="saveCurrentAsPreset()">Save Preset</button>
    </div>
  </div>`

  html += Object.entries(groups).map(([category, steps]) => {
    const catSelected = steps.filter(s => state.selectedStepIds.has(s.id)).length
    const allSelected = catSelected === steps.length
    const color = CATEGORY_COLORS[category] || '#64748b'
    const label = CATEGORY_LABELS[category] || category.charAt(0).toUpperCase() + category.slice(1)

    return `<div class="category-group">
      <div class="category-header" onclick="toggleCategoryCollapse('${category}')">
        <span class="chevron" id="chev-${category}">&#9654;</span>
        <input type="checkbox" ${allSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleCategoryAll('${category}', this.checked)" style="flex-shrink:0">
        <span style="color:${color}">${label}</span>
        <span class="category-count">${catSelected}/${steps.length}</span>
      </div>
      <div class="category-steps" id="cat-${category}">
        ${steps.map(step =>
          `<div class="step-row">
            <input type="checkbox" ${state.selectedStepIds.has(step.id) ? 'checked' : ''} onchange="toggleStep('${step.id}')">
            <span class="step-name">${escapeHtml(step.name)}</span>
          </div>`
        ).join('')}
      </div>
    </div>`
  }).join('')

  return html
}

// ====== ACTION BAR ======

function renderActionBar() {
  const count = state.selectedStepIds.size
  return `<div style="display:flex;gap:12px;align-items:center;padding:16px 0;border-top:1px solid var(--border);margin-top:12px">
    <button class="btn-success" ${count === 0 ? 'disabled' : ''} onclick="startNewRun()">
      \u25B6 Start Run (${count} step${count !== 1 ? 's' : ''})
    </button>
    <div style="display:flex;gap:8px;align-items:center">
      <label class="form-label" style="margin:0;white-space:nowrap">Timeout:</label>
      <input type="number" id="step-timeout" value="${state.settings.defaultTimeout || 45}" min="5" max="120" style="width:70px;padding:4px 8px;font-size:13px"> min
    </div>
  </div>`
}

// ====== DASHBOARD VIEW (unified) ======

function renderDashboardStats(runs) {
  if (runs.length === 0) return ''
  const lastRun = runs[0]
  const totalRuns = runs.length
  const passRateRuns = runs.filter(r => r.status === 'completed')
  const passRate = totalRuns > 0 ? Math.round((passRateRuns.length / totalRuns) * 100) : 0
  const avgCost = runs.reduce((s, r) => s + (r.total_cost || 0), 0) / totalRuns

  return `<div class="stats-row">
    <div class="stat-card"><div class="stat-value">${new Date(lastRun.started_at).toLocaleDateString()}</div><div class="stat-label">Last Run</div></div>
    <div class="stat-card"><div class="stat-value">${passRate}%</div><div class="stat-label">Pass Rate</div></div>
    <div class="stat-card"><div class="stat-value">${totalRuns}</div><div class="stat-label">Total Runs</div></div>
    <div class="stat-card"><div class="stat-value">$${avgCost.toFixed(2)}</div><div class="stat-label">Avg Cost</div></div>
  </div>`
}

function renderRunHistory(runs) {
  if (runs.length === 0) return ''
  return `<details style="margin-top:16px">
    <summary style="cursor:pointer;font-weight:600;font-size:13px;color:var(--text-secondary);margin-bottom:8px">Run History (${runs.length})</summary>
    <table><thead><tr><th>Date</th><th>Status</th><th>Steps</th><th>Cost</th><th>Duration</th></tr></thead><tbody>
      ${runs.map(r => {
        const duration = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) : null
        return `<tr onclick="viewRunResults('${r.id}')">
          <td>${new Date(r.started_at).toLocaleDateString()} ${new Date(r.started_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${r.steps_passed}/${r.steps_total}</td>
          <td>$${(r.total_cost||0).toFixed(2)}</td>
          <td>${formatDurationShort(duration)}</td>
        </tr>`
      }).join('')}
    </tbody></table>
  </details>`
}

async function loadDashboard() {
  const container = document.getElementById('view-dashboard')

  await loadProjects()

  if (!state.selectedProjectId) {
    container.innerHTML = renderProjectSelector() +
      `<div class="empty-state">
        <h3>Welcome to NightyTidy</h3>
        <p>Select a project to configure and run automated codebase improvements.</p>
      </div>`
    return
  }

  try {
    const [steps, presets, runs] = await Promise.all([
      state.stepsLoaded ? Promise.resolve(state.steps) : amc.nightytidy.getStepLibrary(),
      amc.nightytidy.getPresets(state.selectedProjectId),
      amc.nightytidy.getRunHistory(state.selectedProjectId)
    ])
    state.steps = steps
    state.stepsLoaded = true
    state.presets = presets
    state.runs = runs
  } catch (err) {
    container.innerHTML = renderProjectSelector() +
      `<div class="card" style="color:var(--error)">Failed to load: ${escapeHtml(err.message)}</div>`
    return
  }

  const activeRun = state.runs.find(r => r.status === 'running')
  if (activeRun) {
    state.activeRun = activeRun
    showView('live-run')
    loadLiveRun()
    return
  }

  // Select all steps by default on first load
  if (state.selectedStepIds.size === 0) {
    state.steps.filter(s => s.enabled).forEach(s => state.selectedStepIds.add(s.id))
  }

  container.innerHTML = renderProjectSelector() +
    renderDashboardStats(state.runs) +
    '<h3 style="margin-bottom:12px;font-size:15px">Select Steps</h3>' +
    renderStepChecklist() +
    renderActionBar() +
    renderRunHistory(state.runs)
}

function onProjectChange(projectId) {
  state.selectedProjectId = projectId || null
  state.runs = []
  state.selectedStepIds.clear()
  state.stepsLoaded = false
  loadDashboard()
}

// ====== STEP INTERACTIONS ======

function toggleStep(stepId) {
  if (state.selectedStepIds.has(stepId)) state.selectedStepIds.delete(stepId)
  else state.selectedStepIds.add(stepId)
  loadDashboard()
}

function toggleCategoryAll(category, checked) {
  state.steps.filter(s => s.category === category && s.enabled).forEach(s => {
    if (checked) state.selectedStepIds.add(s.id)
    else state.selectedStepIds.delete(s.id)
  })
  loadDashboard()
}

function selectAllSteps() {
  state.steps.filter(s => s.enabled).forEach(s => state.selectedStepIds.add(s.id))
  loadDashboard()
}

function selectNoSteps() {
  state.selectedStepIds.clear()
  loadDashboard()
}

function toggleCategoryCollapse(category) {
  const el = document.getElementById('cat-' + category)
  const chev = document.getElementById('chev-' + category)
  if (el) el.classList.toggle('open')
  if (chev) chev.classList.toggle('open')
}

function loadPreset(presetId) {
  if (!presetId) return
  state.selectedStepIds.clear()
  if (presetId === '__all__') { selectAllSteps(); return }
  if (presetId === '__quick__') {
    state.steps.filter(s => s.enabled).slice(0, 10).forEach(s => state.selectedStepIds.add(s.id))
    loadDashboard()
    return
  }
  const preset = state.presets.find(p => p.id === presetId)
  if (preset) {
    const stepIds = preset.step_ids || []
    state.steps.filter(s => stepIds.includes(s.step_id)).forEach(s => state.selectedStepIds.add(s.id))
    loadDashboard()
  }
}

async function saveCurrentAsPreset() {
  const name = prompt('Preset name:')
  if (!name) return
  const stepIds = state.steps.filter(s => state.selectedStepIds.has(s.id)).map(s => s.step_id)
  try {
    await amc.nightytidy.savePreset({ name, project_id: state.selectedProjectId, step_ids: stepIds })
    state.presets = await amc.nightytidy.getPresets(state.selectedProjectId)
    amc.toast.show({ type: 'success', message: `Preset "${name}" saved` })
  } catch (err) {
    amc.toast.show({ type: 'error', message: err.message })
  }
}

async function startNewRun() {
  if (state.selectedStepIds.size === 0) return
  const timeout = parseInt(document.getElementById('step-timeout')?.value || '45', 10)
  try {
    const result = await amc.nightytidy.startRun({
      projectId: state.selectedProjectId,
      stepRowIds: Array.from(state.selectedStepIds),
      timeout
    })
    state.activeRun = { id: result.runId, status: 'running' }
    amc.toast.show({ type: 'success', message: 'NightyTidy run started!' })
    showView('live-run')
    loadLiveRun()
  } catch (err) {
    amc.toast.show({ type: 'error', message: `Failed to start run: ${err.message}` })
  }
}

// ====== LIVE RUN VIEW ======

let liveRunPollInterval = null

async function loadLiveRun() {
  if (!state.activeRun) {
    document.getElementById('view-live-run').innerHTML = '<div class="empty-state"><h3>No active run</h3></div>'
    return
  }
  if (liveRunPollInterval) clearInterval(liveRunPollInterval)
  renderLiveRun()
  liveRunPollInterval = setInterval(async () => {
    if (currentView !== 'live-run') return
    await refreshLiveRun()
  }, 3000)
}

async function refreshLiveRun() {
  if (!state.activeRun) return
  try {
    const status = await amc.nightytidy.getRunStatus(state.activeRun.id)
    if (!status) return
    state.activeRun = status.run
    state.activeRunSteps = status.steps
    renderLiveRun()
    if (['completed','failed','partial','cancelled'].includes(status.run.status)) {
      if (liveRunPollInterval) { clearInterval(liveRunPollInterval); liveRunPollInterval = null }
    }
  } catch (err) { console.error('[NightyTidy] Poll error:', err) }
}

function renderLiveRun() {
  const container = document.getElementById('view-live-run')
  const run = state.activeRun
  const steps = state.activeRunSteps || []
  if (!run) { container.innerHTML = '<div class="empty-state"><h3>No active run</h3></div>'; return }

  const isRunning = run.status === 'running'
  const completedSteps = steps.filter(s => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped')
  const currentStep = steps.find(s => s.status === 'running')
  const progressPct = steps.length > 0 ? Math.round((completedSteps.length / steps.length) * 100) : 0
  const elapsed = Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000)

  container.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">${isRunning ? 'Run in Progress' : 'Run ' + (run.status === 'completed' ? 'Complete' : run.status)}</h3>
        <div style="display:flex;gap:8px">
          ${isRunning
            ? '<button class="btn-secondary" onclick="skipCurrentStep()">Skip Step</button><button class="btn-danger" onclick="cancelActiveRun()">Cancel Run</button>'
            : `<button class="btn-primary" onclick="viewRunResults('${run.id}')">View Results</button>`}
        </div>
      </div>
      <div class="progress-bar" style="margin-bottom:8px"><div class="progress-bar-fill" style="width:${progressPct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted)">
        <span>${completedSteps.length} of ${steps.length} steps</span>
        <span>${formatDurationShort(elapsed)} elapsed</span>
        <span>$${(run.total_cost||0).toFixed(4)}</span>
      </div>
    </div>
    ${currentStep ? `
      <div class="card" style="border-left:3px solid var(--accent)">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="spinner"></span>
          <strong>${escapeHtml(currentStep.step_name)}</strong>
          ${currentStep.attempts > 1 ? `<span class="badge badge-warning">Attempt ${currentStep.attempts}</span>` : ''}
        </div>
      </div>` : ''}
    <div style="margin-top:16px">
      ${steps.map(step => {
        const icon = step.status === 'completed' ? '\u2713' : step.status === 'failed' ? '\u2717' : step.status === 'running' ? '<span class="spinner" style="width:12px;height:12px"></span>' : step.status === 'skipped' ? '\u2014' : '\u25CB'
        const color = step.status === 'completed' ? 'var(--success)' : step.status === 'failed' ? 'var(--error)' : step.status === 'running' ? 'var(--accent)' : 'var(--text-muted)'
        return `<div class="step-row" style="border-left:3px solid ${color};margin-bottom:4px">
          <span style="color:${color};min-width:20px;text-align:center">${icon}</span>
          <span class="step-name">${escapeHtml(step.step_name)}</span>
          ${step.duration ? `<span style="font-size:12px;color:var(--text-muted)">${formatDurationShort(step.duration)}</span>` : ''}
          ${step.cost ? `<span style="font-size:12px;color:var(--text-muted)">$${step.cost.toFixed(4)}</span>` : ''}
        </div>
        ${step.summary && (step.status === 'completed' || step.status === 'failed') ? `<div style="padding:4px 12px 8px 35px;font-size:12px;color:var(--text-secondary)">${escapeHtml(step.summary)}</div>` : ''}`
      }).join('')}
    </div>`
}

async function cancelActiveRun() {
  if (!state.activeRun) return
  if (!confirm('Cancel this run? Completed steps will be preserved.')) return
  try {
    await amc.nightytidy.cancelRun(state.activeRun.id)
    amc.toast.show({ type: 'info', message: 'Run cancelled' })
    if (liveRunPollInterval) { clearInterval(liveRunPollInterval); liveRunPollInterval = null }
    await refreshLiveRun()
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

function skipCurrentStep() {
  amc.toast.show({ type: 'info', message: 'Step will complete or timeout based on the configured timeout setting.' })
}

// ====== RESULTS VIEW ======

async function viewRunResults(runId) {
  showView('results')
  const container = document.getElementById('view-results')
  container.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span> Loading results...</div>'
  try {
    const data = await amc.nightytidy.getRunStatus(runId)
    if (!data) { container.innerHTML = '<div class="empty-state"><h3>Run not found</h3></div>'; return }
    renderResults(container, data.run, data.steps)
  } catch (err) { container.innerHTML = `<div class="card" style="color:var(--error)">${escapeHtml(err.message)}</div>` }
}

function renderResults(container, run, steps) {
  const duration = run.finished_at ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000) : null
  container.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <h3 style="margin:0 0 4px 0">Run Results ${statusBadge(run.status)}</h3>
          <div style="font-size:12px;color:var(--text-muted)">${new Date(run.started_at).toLocaleString()}${duration ? ' \u2014 ' + formatDurationShort(duration) : ''}</div>
        </div>
        <button class="btn-secondary" onclick="showView('dashboard'); loadDashboard()">Back</button>
      </div>
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value" style="color:var(--success)">${run.steps_passed}</div><div class="stat-label">Passed</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--error)">${run.steps_failed}</div><div class="stat-label">Failed</div></div>
        <div class="stat-card"><div class="stat-value">$${(run.total_cost||0).toFixed(2)}</div><div class="stat-label">Cost</div></div>
        <div class="stat-card"><div class="stat-value">${run.git_branch || '\u2014'}</div><div class="stat-label">Branch</div></div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      ${run.report_path ? `<button class="btn-secondary" onclick="amc.toast.show({type:'info',message:'Report at: ${escapeHtml(run.report_path)}'})">View Report</button>` : ''}
      <button class="btn-danger" onclick="rollbackRunConfirm('${run.id}')">Rollback</button>
      <button class="btn-primary" onclick="mergeRunConfirm('${run.id}')">Merge Branch</button>
      ${run.steps_failed > 0 ? `<button class="btn-secondary" onclick="rerunFailed('${run.id}')">Re-run Failed</button>` : ''}
    </div>
    <h3 style="margin-bottom:12px">Step Results</h3>
    ${steps.map((step, i) => {
      const icon = step.status === 'completed' ? '\u2713' : step.status === 'failed' ? '\u2717' : '\u2014'
      const color = step.status === 'completed' ? 'var(--success)' : step.status === 'failed' ? 'var(--error)' : 'var(--text-muted)'
      return `<div class="card" style="border-left:3px solid ${color};margin-bottom:8px">
        <div class="accordion-header" onclick="toggleAccordion('result-${i}')">
          <div style="display:flex;align-items:center;gap:8px"><span style="color:${color}">${icon}</span><strong>${escapeHtml(step.step_name)}</strong>${statusBadge(step.status)}</div>
          <div style="display:flex;gap:12px;font-size:12px;color:var(--text-muted)"><span>${formatDurationShort(step.duration)}</span><span>$${(step.cost||0).toFixed(4)}</span><span>${step.attempts} attempt${step.attempts !== 1 ? 's' : ''}</span></div>
        </div>
        <div class="accordion-body" id="result-${i}">
          ${step.summary ? `<p style="margin-bottom:8px">${escapeHtml(step.summary)}</p>` : ''}
          ${step.error ? `<p style="color:var(--error);margin-bottom:8px"><strong>Error:</strong> ${escapeHtml(step.error)}</p>` : ''}
          ${step.output ? `<details><summary style="cursor:pointer;font-size:12px;color:var(--text-muted)">Full Output</summary><pre style="background:var(--bg-secondary);padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;margin-top:8px;white-space:pre-wrap">${escapeHtml(step.output)}</pre></details>` : ''}
        </div>
      </div>`
    }).join('')}`
}

function toggleAccordion(id) {
  const el = document.getElementById(id)
  if (el) el.classList.toggle('open')
}

async function rollbackRunConfirm(runId) {
  if (!confirm('This will delete the NightyTidy branch and revert all changes. Are you sure?')) return
  try {
    await amc.nightytidy.rollbackRun(runId)
    amc.toast.show({ type: 'success', message: 'Run rolled back successfully' })
    showView('dashboard'); loadDashboard()
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

async function mergeRunConfirm(runId) {
  if (!confirm('Merge the NightyTidy branch into your project branch?')) return
  try {
    await amc.nightytidy.mergeRun(runId)
    amc.toast.show({ type: 'success', message: 'Branch merged successfully!' })
    showView('dashboard'); loadDashboard()
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

async function rerunFailed(runId) {
  const data = await amc.nightytidy.getRunStatus(runId)
  if (!data) return
  state.selectedStepIds.clear()
  const failedStepIds = data.steps.filter(s => s.status === 'failed').map(s => s.step_id)
  state.steps.filter(s => failedStepIds.includes(s.step_id)).forEach(s => state.selectedStepIds.add(s.id))
  showView('dashboard'); loadDashboard()
}

// ====== SETTINGS VIEW ======

async function loadSettings() {
  const container = document.getElementById('view-settings')
  try {
    state.settings = await amc.settings.getAll()
    state.steps = await amc.nightytidy.getStepLibrary()
    state.schedules = state.selectedProjectId ? await amc.nightytidy.getSchedules(state.selectedProjectId) : []
  } catch (err) {
    container.innerHTML = `<div class="card" style="color:var(--error)">${escapeHtml(err.message)}</div>`
    return
  }
  renderSettingsView(container)
}

function renderSettingsView(container) {
  container.innerHTML = `
    <h3 style="margin-bottom:16px">Settings</h3>
    <div class="card">
      <div class="form-group"><label class="form-label">Step Timeout (minutes)</label><input type="number" id="setting-timeout" value="${state.settings.defaultTimeout ?? 45}" min="5" max="120"></div>
      <div class="form-group"><label class="form-label">Max Retries Per Step</label><input type="number" id="setting-retries" value="${state.settings.maxRetries ?? 3}" min="1" max="5"></div>
      <div class="form-group" style="display:flex;justify-content:space-between;align-items:center"><label class="form-label" style="margin:0">Generate Report</label><input type="checkbox" id="setting-report" ${state.settings.generateReport !== false ? 'checked' : ''}></div>
      <div class="form-group" style="display:flex;justify-content:space-between;align-items:center"><label class="form-label" style="margin:0">Auto-Merge on Success</label><input type="checkbox" id="setting-automerge" ${state.settings.autoMerge ? 'checked' : ''}></div>
      <button class="btn-primary" onclick="saveSettings()">Save Settings</button>
    </div>

    <h3 style="margin:24px 0 16px">Step Library</h3>
    <div style="margin-bottom:12px"><button class="btn-secondary" onclick="showAddStepForm()">+ Add Custom Step</button></div>
    <div id="step-library-list">
      ${state.steps.map(step => {
        const color = CATEGORY_COLORS[step.category] || '#64748b'
        return `<div class="step-row" style="margin-bottom:4px;border-left:3px solid ${color}">
          <span style="color:${color}">\u25CF</span>
          <span style="flex:1"><strong>${escapeHtml(step.name)}</strong> <span style="font-size:11px;color:var(--text-muted)">${step.is_builtin ? 'built-in' : 'custom'}</span></span>
          <span class="step-category-tag" style="background:${color}20;color:${color}">${CATEGORY_LABELS[step.category] || step.category}</span>
          <label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" ${step.enabled ? 'checked' : ''} onchange="toggleStepEnabled('${step.id}', this.checked)"> Enabled</label>
          <button class="btn-secondary" style="padding:4px 8px;font-size:11px" onclick="editStep('${step.id}')">Edit</button>
          ${step.is_builtin ? `<button class="btn-secondary" style="padding:4px 8px;font-size:11px" onclick="resetStep('${step.id}')">Reset</button>` : ''}
          ${!step.is_builtin ? `<button class="btn-danger" style="padding:4px 8px;font-size:11px" onclick="deleteStep('${step.id}')">Delete</button>` : ''}
        </div>`
      }).join('')}
    </div>

    ${state.selectedProjectId ? `
      <h3 style="margin:24px 0 16px">Schedules</h3>
      <div id="schedules-section">
        ${renderSchedules()}
        <button class="btn-secondary" onclick="showAddScheduleForm()">+ Add Schedule</button>
      </div>` : ''}`
}

function renderSchedules() {
  if (state.schedules.length === 0) return '<p style="color:var(--text-muted);margin-bottom:12px">No schedules configured.</p>'
  const DAY_NAMES = ['S','M','T','W','T','F','S']
  return state.schedules.map(sch => `
    <div class="card" style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="day-toggles">${DAY_NAMES.map((d,i) => `<span class="day-toggle ${(sch.days||[]).includes(i) ? 'active' : ''}" style="pointer-events:none">${d}</span>`).join('')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">at ${sch.time || '23:00'}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" ${sch.enabled ? 'checked' : ''} onchange="toggleSchedule('${sch.id}', this.checked)"> Active</label>
          <button class="btn-danger" style="padding:4px 8px;font-size:11px" onclick="deleteSchedule('${sch.id}')">Delete</button>
        </div>
      </div>
    </div>`
  ).join('')
}

async function saveSettings() { amc.toast.show({ type: 'info', message: 'Settings are managed via AMC Settings > Plugins > NightyTidy' }) }

async function toggleStepEnabled(stepId, enabled) {
  try { await amc.nightytidy.updateStep(stepId, { enabled: enabled ? 1 : 0 }); state.steps = await amc.nightytidy.getStepLibrary() }
  catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

async function editStep(stepId) {
  const step = state.steps.find(s => s.id === stepId)
  if (!step) return
  const newPrompt = prompt('Edit prompt for ' + step.name + ':', step.prompt)
  if (newPrompt === null) return
  try {
    await amc.nightytidy.updateStep(stepId, { prompt: newPrompt })
    amc.toast.show({ type: 'success', message: 'Step updated' })
    state.steps = await amc.nightytidy.getStepLibrary()
    renderSettingsView(document.getElementById('view-settings'))
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

async function resetStep(stepId) {
  if (!confirm('Reset this step to its original prompt?')) return
  try {
    await amc.nightytidy.resetBuiltinStep(stepId)
    amc.toast.show({ type: 'success', message: 'Step reset to default' })
    state.steps = await amc.nightytidy.getStepLibrary()
    renderSettingsView(document.getElementById('view-settings'))
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

async function deleteStep(stepId) {
  if (!confirm('Delete this custom step?')) return
  try {
    await amc.nightytidy.deleteCustomStep(stepId)
    amc.toast.show({ type: 'success', message: 'Step deleted' })
    state.steps = await amc.nightytidy.getStepLibrary()
    renderSettingsView(document.getElementById('view-settings'))
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

function showAddStepForm() {
  const name = prompt('Step name:')
  if (!name) return
  const category = prompt('Category (documentation, testing, security, performance, architecture, ux, infrastructure, product):')
  if (!category) return
  const stepPrompt = prompt('Step prompt (what should Claude do?):')
  if (!stepPrompt) return
  createNewCustomStep(name, category, stepPrompt)
}

async function createNewCustomStep(name, category, stepPrompt) {
  try {
    await amc.nightytidy.createCustomStep({ name, prompt: stepPrompt, category })
    amc.toast.show({ type: 'success', message: 'Custom step created' })
    state.steps = await amc.nightytidy.getStepLibrary()
    renderSettingsView(document.getElementById('view-settings'))
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

async function toggleSchedule(scheduleId, enabled) {
  try {
    await amc.nightytidy.updateSchedule(scheduleId, { enabled: enabled ? 1 : 0 })
    state.schedules = await amc.nightytidy.getSchedules(state.selectedProjectId)
    renderSettingsView(document.getElementById('view-settings'))
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

async function deleteSchedule(scheduleId) {
  if (!confirm('Delete this schedule?')) return
  try {
    await amc.nightytidy.deleteSchedule(scheduleId)
    amc.toast.show({ type: 'success', message: 'Schedule deleted' })
    state.schedules = await amc.nightytidy.getSchedules(state.selectedProjectId)
    renderSettingsView(document.getElementById('view-settings'))
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

function showAddScheduleForm() {
  const time = prompt('Run time (HH:MM, 24h format):', '23:00')
  if (!time) return
  const daysStr = prompt('Days (comma-separated numbers: 0=Sun, 1=Mon, ..., 6=Sat):', '1,2,3,4,5')
  if (!daysStr) return
  const days = daysStr.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d))
  createNewSchedule(days, time)
}

async function createNewSchedule(days, time) {
  try {
    await amc.nightytidy.createSchedule({ project_id: state.selectedProjectId, days, time, step_preset_id: null, enabled: 1 })
    amc.toast.show({ type: 'success', message: 'Schedule created' })
    state.schedules = await amc.nightytidy.getSchedules(state.selectedProjectId)
    renderSettingsView(document.getElementById('view-settings'))
  } catch (err) { amc.toast.show({ type: 'error', message: err.message }) }
}

// ====== INIT ======

async function init() {
  const theme = await amc.theme.get()
  if (theme && theme.mode === 'light') document.documentElement.setAttribute('data-theme', 'light')
  amc.theme.onChange(t => { document.documentElement.setAttribute('data-theme', t.mode === 'light' ? 'light' : '') })
  renderTabBar()
  await loadDashboard()
}

init().catch(err => console.error('[NightyTidy] init failed:', err))

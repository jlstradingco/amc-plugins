// PRDStack Plugin — Main Entry Point
// Communicates with Agent Mission Control via window.AgentMC bridge API
// Uses CLI sessions through the process manager for AI conversation

const amc = window.AgentMC

// -- State -------------------------------------------------------------------
let currentPrd = null
let currentStep = null
let currentSessionId = null
let roundCount = 0
let pollTimer = null
let lastMessageCount = 0
let isWaitingForResponse = false
let lastAssistantContent = '' // tracks last AI message for conclusion detection
let awaitingFinalization = false // true after user clicks CTA — waiting for AI to write final doc
let selectedExportFolder = null // folder picked by user for Decomposer file export
const needsYouPrdIds = new Set() // PRD IDs with sessions waiting for user input
let buildThisNowVerified = null // cached disk verification result for current viewer

// -- Host Sidebar Sync -------------------------------------------------------
/** Push current PRD list to the host app's sidebar panel */
async function pushSidebarItems() {
  try {
    const prds = await amc.db.query('prds', { orderBy: { updated_at: 'desc' } })
    const items = prds.map((prd) => ({
      id: prd.id,
      title: prd.title || 'Untitled PRD',
      status: prd.status,
      needsYou: needsYouPrdIds.has(prd.id),
      progress: prd.progress ?? 0,
      currentStep: prd.current_step,
      totalSteps: V3_STEPS.length,
    }))
    amc.sidebar.setItems(items)
    // Also update badge count
    amc.sidebar.setBadge(needsYouPrdIds.size)
  } catch (err) {
    console.warn('[PRDStack] Failed to push sidebar items:', err)
  }
}

// -- Step Definitions --------------------------------------------------------
const V3_STEPS = [
  { order: 1, title: 'Product Vision', phase: 'Discovery', file: '001_vision.md', maxRounds: 6 },
  { order: 2, title: 'Feature List', phase: 'Discovery', file: '002_feature_list.md', maxRounds: 5 },
  { order: 3, title: 'User Journey', phase: 'Discovery', file: '003_user_journey.md', maxRounds: 4 },
  { order: 4, title: 'Technical Hurdles', phase: 'Architecture', file: '004_technical_hurdles.md', maxRounds: 4 },
  { order: 5, title: 'Design Language', phase: 'Architecture', file: '005_design_language.md', maxRounds: 5 },
  { order: 6, title: 'Tech Stack', phase: 'Architecture', file: '006_tech_stack.md', maxRounds: 5 },
  { order: 7, title: 'Data Flow', phase: 'Architecture', file: '007_data_flow.md', maxRounds: 4 },
  { order: 8, title: 'User Red Team', phase: 'Red Team', file: '008_user_red_team.md', maxRounds: 3 },
  { order: 9, title: 'Developer Red Team', phase: 'Red Team', file: '009_developer_red_team.md', maxRounds: 3 },
  { order: 10, title: 'Designer Red Team', phase: 'Red Team', file: '010_designer_red_team.md', maxRounds: 3 },
  { order: 11, title: 'Manual Work', phase: 'Implementation', file: '011_manual_work.md', maxRounds: 3 },
  { order: 12, title: 'Final Improvement', phase: 'Implementation', file: '012_final_improvement.md', maxRounds: 3 },
  { order: 13, title: 'Decomposer', phase: 'Implementation', file: '013_decomposer.md', maxRounds: 3 },
]

// -- Initialization ----------------------------------------------------------
document.addEventListener('DOMContentLoaded', init)

async function init() {
  document.getElementById('new-prd-btn').addEventListener('click', createNewPrd)
  document.getElementById('send-btn').addEventListener('click', sendMessage)
  document.getElementById('complete-step-btn').addEventListener('click', completeStep)
  document.getElementById('back-btn').addEventListener('click', showDashboard)
  document.getElementById('viewer-back-btn').addEventListener('click', showDashboard)
  document.getElementById('viewer-export-btn').addEventListener('click', exportPrds)
  document.getElementById('viewer-build-btn').addEventListener('click', handleBuildThisNowFromViewer)
  document.getElementById('autopilot-btn').addEventListener('click', () => {
    if (typeof startAutopilotIntake === 'function') startAutopilotIntake()
  })

  const input = document.getElementById('user-input')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })
  input.addEventListener('input', () => {
    // Auto-resize textarea
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
    // Enable/disable send button
    document.getElementById('send-btn').disabled = !input.value.trim() || isWaitingForResponse
    // Keep messages scrolled to bottom as input grows
    const messages = document.getElementById('messages')
    messages.scrollTop = messages.scrollHeight
  })

  await loadDashboard()

  // Check for pending navigation (e.g., user clicked PRD in Inbox)
  await checkPendingNavigation()

  // Listen for visibility changes — plugin may be hidden/shown as user navigates
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkPendingNavigation()
  })
}

/** Check KV store for a pending navigation target and navigate to it */
async function checkPendingNavigation() {
  try {
    const prdId = await amc.storage.get('pending_navigation')
    if (!prdId) return
    // Clear immediately to prevent re-navigation
    await amc.storage.set('pending_navigation', null)
    console.log('[PRDStack] navigating to PRD from pending_navigation:', prdId)
    await openPrd(prdId)
  } catch (err) {
    console.warn('[PRDStack] checkPendingNavigation failed:', err)
  }
}

// -- Dashboard ---------------------------------------------------------------
async function loadDashboard() {
  let prds
  try {
    prds = await amc.db.query('prds', { orderBy: { updated_at: 'desc' } })
    console.log('[PRDStack] loadDashboard: found', prds.length, 'PRDs', prds)
  } catch (err) {
    console.error('[PRDStack] loadDashboard query failed:', err)
    prds = []
  }
  const list = document.getElementById('prd-list')
  const empty = document.getElementById('empty-state')

  list.innerHTML = ''

  if (prds.length === 0) {
    empty.classList.remove('hidden')
    return
  }
  empty.classList.add('hidden')

  for (const prd of prds) {
    const stepDef = V3_STEPS[prd.current_step - 1]
    const card = document.createElement('div')
    card.className = 'prd-card'
    card.innerHTML = `
      <div class="prd-card-header">
        <h3>${escapeHtml(prd.title)}</h3>
        <span class="status-badge ${prd.status}">${formatStatus(prd.status)}</span>
      </div>
      <div class="meta">Step ${prd.current_step}/${V3_STEPS.length} &middot; ${stepDef?.title ?? 'Complete'} &middot; ${formatDate(prd.updated_at)}</div>
      <div class="progress-bar"><div class="progress-fill" style="width: ${prd.progress}%"></div></div>
      <div class="prd-card-actions">
        ${prd.status === 'completed'
          ? '<button class="btn btn-secondary btn-sm view-btn">View PRD</button>'
          : '<button class="btn btn-primary btn-sm continue-btn">Continue</button>'
        }
        <button class="btn btn-ghost btn-sm delete-btn">Delete</button>
      </div>
    `
    // Card click opens the PRD
    card.querySelector('.continue-btn, .view-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (prd.status === 'completed') openViewer(prd.id)
      else openPrd(prd.id)
    })
    card.querySelector('.delete-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      deletePrd(prd.id)
    })
    card.addEventListener('click', () => {
      if (prd.status === 'completed') openViewer(prd.id)
      else openPrd(prd.id)
    })
    list.appendChild(card)
  }

  // Sync sidebar in host app
  pushSidebarItems()
}

function showDashboard() {
  stopPolling()
  if (currentSessionId) {
    amc.session.stop(currentSessionId).catch(() => {})
  }
  currentPrd = null
  currentStep = null
  currentSessionId = null
  roundCount = 0
  lastMessageCount = 0
  isWaitingForResponse = false
  lastAssistantContent = ''
  awaitingFinalization = false
  buildThisNowVerified = null

  document.getElementById('dashboard-view').classList.remove('hidden')
  document.getElementById('builder-view').classList.add('hidden')
  document.getElementById('viewer-view').classList.add('hidden')
  loadDashboard()
}

function showView(viewId) {
  document.getElementById('dashboard-view').classList.add('hidden')
  document.getElementById('builder-view').classList.add('hidden')
  document.getElementById('viewer-view').classList.add('hidden')
  document.getElementById('intake-view').classList.add('hidden')
  document.getElementById('autopilot-view').classList.add('hidden')
  document.getElementById('completion-view').classList.add('hidden')
  document.getElementById(viewId).classList.remove('hidden')
}

// -- PRD Creation ------------------------------------------------------------
async function createNewPrd() {
  const prd = await amc.db.insert('prds', {
    title: 'Untitled PRD',
    status: 'draft',
    progress: 0,
    flow_version: 'v3',
    current_step: 1,
    project_context: {},
  })

  for (const step of V3_STEPS) {
    await amc.db.insert('steps', {
      prd_id: prd.id,
      order: step.order,
      title: step.title,
      phase: step.phase,
      is_completed: 0,
      generated_content: '',
      context_summary: '',
    })
  }

  await openPrd(prd.id)
  pushSidebarItems()
}

async function deletePrd(prdId) {
  const prd = await amc.db.getById('prds', prdId)
  const name = prd?.title || 'this PRD'
  const confirmed = await showConfirm(
    'Delete PRD',
    `Are you sure you want to delete "${name}"? This will remove all steps, messages, and generated content. This cannot be undone.`
  )
  if (!confirmed) return

  // Clean up associated data
  await amc.db.deleteWhere('prd_files', { prd_id: prdId })
  await amc.db.deleteWhere('messages', { prd_id: prdId })
  await amc.db.deleteWhere('steps', { prd_id: prdId })
  await amc.db.delete('prds', prdId)
  amc.toast.show({ type: 'success', message: 'PRD deleted' })
  await loadDashboard()
}

/** Promise-based confirmation dialog */
function showConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-secondary btn-sm confirm-cancel">Cancel</button>
          <button class="btn btn-danger btn-sm confirm-delete">Delete</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    const cleanup = (result) => {
      overlay.remove()
      resolve(result)
    }
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false))
    overlay.querySelector('.confirm-delete').addEventListener('click', () => cleanup(true))
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false) })
  })
}

// -- PRD Opening -------------------------------------------------------------
async function openPrd(prdId) {
  currentPrd = await amc.db.getById('prds', prdId)
  if (!currentPrd) return

  // Completed PRDs always open in the viewer (which has Export + Build buttons)
  if (currentPrd.status === 'completed') return openViewer(prdId)

  // Check for active autopilot state — restore if present
  if (typeof restoreAutopilot === 'function') {
    try {
      const restored = await restoreAutopilot(currentPrd)
      if (restored) return
    } catch (err) {
      console.warn('[PRDStack] Autopilot restore failed, falling back to builder:', err)
    }
  }

  const steps = await amc.db.query('steps', { where: { prd_id: prdId }, orderBy: { order: 'asc' } })

  showView('builder-view')

  // Update header
  document.getElementById('prd-title').textContent = currentPrd.title
  updateProgress(steps)

  renderStepSidebar(steps)
  await openStep(steps.find((s) => s.order === currentPrd.current_step) || steps[0])
}

// -- Step Sidebar ------------------------------------------------------------
function renderStepSidebar(steps) {
  const sidebar = document.getElementById('step-sidebar')
  sidebar.innerHTML = ''

  let currentPhase = ''
  for (const step of steps) {
    if (step.phase !== currentPhase) {
      currentPhase = step.phase
      const header = document.createElement('div')
      header.className = 'phase-header'
      header.textContent = currentPhase
      sidebar.appendChild(header)
    }

    const isActive = step.order === currentPrd.current_step
    const isCompleted = step.is_completed
    const isLocked = step.order > currentPrd.current_step && !isCompleted

    const item = document.createElement('div')
    item.className = `step-item${isCompleted ? ' completed' : ''}${isActive ? ' active' : ''}${isLocked ? ' locked' : ''}`
    item.innerHTML = `<div class="step-dot"></div><span>${step.title}</span>`
    if (!isLocked) {
      item.addEventListener('click', () => openStep(step))
    }
    sidebar.appendChild(item)
  }
}

function updateProgress(steps) {
  const completedCount = steps.filter((s) => s.is_completed).length
  const pct = Math.round((completedCount / steps.length) * 100)
  const progressInfo = document.getElementById('progress-info')
  if (pct === 100) {
    progressInfo.innerHTML = '<span class="progress-complete-text">Complete</span>'
  } else {
    progressInfo.textContent =
      `Step ${currentPrd.current_step} of ${V3_STEPS.length} - ${pct}% complete`
  }
  document.getElementById('progress-fill').style.width = `${pct}%`
}

// -- Step Execution ----------------------------------------------------------
async function openStep(step) {
  currentStep = step
  roundCount = 0
  lastMessageCount = 0
  isWaitingForResponse = false
  lastAssistantContent = ''
  awaitingFinalization = false

  // Update conversation header
  document.getElementById('step-title').textContent = step.title
  document.getElementById('step-badge').textContent = `Step ${step.order} of ${V3_STEPS.length}`
  document.getElementById('round-counter').textContent = ''

  // Load existing messages for this step from plugin DB
  const messages = await amc.db.query('messages', {
    where: { step_id: step.id },
    orderBy: { created_at: 'asc' }
  })
  renderMessages(messages)

  // Count completed rounds (user→assistant exchanges, not just user messages)
  // This prevents inflated counts from duplicate/unanswered sends
  roundCount = messages.filter((m) => m.role === 'assistant').length
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  if (lastAssistant) lastAssistantContent = lastAssistant.content

  // Recovery: check KV store for a persisted session with missed messages
  // (happens when user navigated away during a conversation and the webview was destroyed)
  if (messages.length > 0 && !step.is_completed) {
    try {
      await recoverMissedMessages(step, messages)
    } catch (err) {
      console.warn('[PRDStack] Recovery failed (non-fatal):', err)
    }
  }

  // Update step actions visibility — always runs even if recovery failed
  updateStepActions()

  // Enable input
  setInputEnabled(!step.is_completed)

  // If step 13 is completed, show the file browser instead of messages
  const stepDef = V3_STEPS.find((s) => s.order === step.order)
  if (stepDef && stepDef.order === V3_STEPS.length && step.is_completed) {
    await showFileBrowser(currentPrd.id)
    return
  }

  // If step has no messages yet and isn't completed, start it
  if (messages.length === 0 && !step.is_completed) {
    await startStep(step)
  }
}

/** Persist session ID for a step using KV store (schema-free, can't fail on missing columns) */
function persistStepSession(stepId, sessionId) {
  amc.storage.set(`step_session:${stepId}`, sessionId).catch((err) => {
    console.warn('[PRDStack] Failed to persist step session ID:', err)
  })
}

/** Look up the persisted session ID for a step */
async function getStepSession(stepId) {
  try {
    return await amc.storage.get(`step_session:${stepId}`)
  } catch {
    return null
  }
}

/** Recover AI messages that arrived while the webview was destroyed (user navigated away) */
async function recoverMissedMessages(step, existingMessages) {
  // Look up the session ID from KV store
  const sessionId = await getStepSession(step.id)
  if (!sessionId) return

  try {
    const cliMessages = await amc.session.getMessages(sessionId)
    const cliAssistant = cliMessages.filter((m) => m.role === 'assistant')
    const savedAssistant = existingMessages.filter((m) => m.role === 'assistant')

    if (cliAssistant.length > savedAssistant.length) {
      console.log(
        `[PRDStack] Recovering ${cliAssistant.length - savedAssistant.length} missed assistant messages`
      )
      for (let i = savedAssistant.length; i < cliAssistant.length; i++) {
        const msg = cliAssistant[i]
        await amc.db.insert('messages', {
          step_id: step.id,
          prd_id: currentPrd.id,
          role: 'assistant',
          content: msg.content,
        })
        appendMessage('assistant', msg.content)
        lastAssistantContent = msg.content
      }
      // Update round counter display
      updateRoundCounter()
    }

    // Restore live session connection if it's still running
    const status = await amc.session.getStatus(sessionId)
    if (status.status === 'running' || status.status === 'starting') {
      // Session still processing — resume polling
      currentSessionId = sessionId
      lastMessageCount = cliAssistant.length
      startPolling()
    } else if (status.status === 'needs_you' || status.status === 'ready') {
      // Session waiting for input — reconnect and enable input
      currentSessionId = sessionId
      lastMessageCount = cliAssistant.length
    }
    // If ended/error, leave currentSessionId null — sendMessage will create a new session
  } catch (err) {
    console.warn('[PRDStack] Recovery check failed (session may have been cleaned up):', err)
  }
}

async function startStep(step) {
  const stepDef = V3_STEPS.find((s) => s.order === step.order)
  if (!stepDef) return

  // Always restore input area visibility (Decomposer hides it)
  const inputArea = document.querySelector('.input-area')
  if (inputArea) inputArea.style.display = ''

  try {
    // Decomposer (final step) has a completely different flow — guided export, not a conversation
    if (stepDef.order === V3_STEPS.length) {
      await startDecomposer(step, stepDef)
      return
    }

    // Check if we have context from prior completed steps
    const completedSteps = await amc.db.query('steps', {
      where: { prd_id: currentPrd.id, is_completed: 1 },
      orderBy: { order: 'asc' },
    })
    const hasPriorContext = completedSteps.length > 0

    if (hasPriorContext) {
      // Steps 2+: Spawn CLI session upfront — its first response is the personalized intro
      await startStepWithContext(step, stepDef, completedSteps)
      // Input stays disabled until CLI responds (polling loop enables it)
    } else {
      // Step 1: Show the static <first_response> from the prompt file
      await startStepStatic(step, stepDef)
      setInputEnabled(true)
    }
  } catch (err) {
    console.error('[PRDStack] Failed to start step:', err)
    amc.toast.show({ type: 'error', message: `Failed to load step: ${err.message || err}` })
  }
}

/** Step 1: Show the hardcoded first_response from the prompt file */
async function startStepStatic(step, stepDef) {
  const stepPrompt = await amc.assets.readFile(`prompts/v3/${stepDef.file}`)
  const firstResponse = extractFirstResponse(stepPrompt)

  if (firstResponse) {
    await amc.db.insert('messages', {
      step_id: step.id,
      prd_id: currentPrd.id,
      role: 'assistant',
      content: firstResponse,
    })
    appendMessage('assistant', firstResponse)
    lastAssistantContent = firstResponse
  }
}

/** Steps 2+: Spawn CLI session — its first response becomes the personalized intro.
 *  The same session then handles the full conversation for this step. */
async function startStepWithContext(step, stepDef, completedSteps) {
  showThinking()
  isWaitingForResponse = true

  try {
    // Build the full system prompt (includes prior step context)
    const systemPrompt = await buildSystemPrompt(step, stepDef)

    const projectName = currentPrd.title !== 'Untitled PRD' ? currentPrd.title : 'this project'

    // Instruction that tells the CLI to generate a personalized intro
    const introInstruction =
      `You are starting a new step of a PRD process for "${projectName}". ` +
      `Based on the project context provided in your system instructions, generate a brief personalized ` +
      `introduction for this step: ${stepDef.title}.\n\n` +
      `1. Reference the project by name\n` +
      `2. Acknowledge what was accomplished in prior steps\n` +
      `3. Explain what this step will focus on\n` +
      `4. End with 2-3 specific, substantive questions to get started (numbered)\n\n` +
      `Rules:\n` +
      `- Do NOT ask "What product are you building?" — we already know\n` +
      `- Do NOT say "I'm excited" or "I'm thrilled"\n` +
      `- Do NOT ask for permission to begin — dive straight into questions\n` +
      `- Keep it concise — no more than ~200 words\n` +
      `- Use markdown formatting (bold, numbered lists)`

    const fullPrompt = systemPrompt + '\n\n---\n\n' + introInstruction

    // Spawn CLI session — polling will capture its first response as the intro
    const result = await amc.session.create({ prompt: fullPrompt })
    currentSessionId = result.sessionId
    // Persist session ID for recovery (fire-and-forget — must not block polling)
    persistStepSession(step.id, currentSessionId)

    // Start polling — will show the intro when it arrives and enable input
    startPolling()
  } catch (err) {
    console.warn('[PRDStack] CLI session for intro failed, using template fallback:', err)
    hideThinking()
    isWaitingForResponse = false

    // Template fallback if CLI spawn fails
    const projectName = currentPrd.title !== 'Untitled PRD' ? currentPrd.title : 'this project'
    const priorStepNames = completedSteps.map((s) => `**${s.title}**`).join(', ')
    const fallbackMessage =
      `Great progress on **${projectName}**! We've completed ${priorStepNames}. ` +
      `Now let's move on to **${stepDef.title}**.\n\nWhat would you like to start with?`

    await amc.db.insert('messages', {
      step_id: step.id,
      prd_id: currentPrd.id,
      role: 'assistant',
      content: fallbackMessage,
    })
    appendMessage('assistant', fallbackMessage)
    setInputEnabled(true)
  }
}

// -- Decomposer (Final Step) — Guided Export Flow ----------------------------

/** The Decomposer is NOT a conversation. It's a guided export:
 *  1. Show intro with folder picker
 *  2. User picks project folder
 *  3. AI generates all file content (behind the scenes)
 *  4. Files are written to docs/planning/ with progress UI
 *  5. KICKOFF.md is generated
 *  6. Step auto-completes */
async function startDecomposer(step, stepDef) {
  // Hide the normal chat input — Decomposer doesn't use it
  const inputArea = document.querySelector('.input-area')
  if (inputArea) inputArea.style.display = 'none'

  const projectName = currentPrd.title || 'your project'

  // Count completed steps for the summary
  const completedSteps = await amc.db.query('steps', {
    where: { prd_id: currentPrd.id, is_completed: 1 },
    orderBy: { order: 'asc' },
  })
  const stepNames = completedSteps.map((s) => s.title).join(', ')

  // Show the intro message
  const container = document.getElementById('messages')
  container.innerHTML = ''

  const intro = document.createElement('div')
  intro.className = 'decomposer-intro'
  intro.innerHTML = `
    <div class="decomposer-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
    </div>
    <h2>PRD Ready for Export</h2>
    <p class="decomposer-summary">
      <strong>${escapeHtml(projectName)}</strong> has been through all 12 planning steps:
      ${escapeHtml(stepNames)}.
    </p>
    <p class="decomposer-desc">
      Your PRD will be decomposed into individual implementation files and written to
      <code>docs/planning/</code> inside your project folder. A <code>KICKOFF.md</code>
      prompt will also be created — use it to start building with Claude Code.
    </p>
    <div class="decomposer-folder-section">
      <label>Project Folder</label>
      <div class="folder-picker-row">
        <input type="text" id="folder-path-input" class="folder-path-input" placeholder="Select a folder..." readonly />
        <button class="btn btn-secondary btn-sm" id="browse-folder-btn">Browse...</button>
      </div>
    </div>
    <button class="decomposer-start-btn" id="start-export-btn" disabled>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
      Generate &amp; Export PRD Files
    </button>
  `
  container.appendChild(intro)

  // Folder picker
  document.getElementById('browse-folder-btn').addEventListener('click', async () => {
    const result = await amc.export.pickFolder({
      title: `Select project folder for "${projectName}"`,
    })
    if (result.selected) {
      selectedExportFolder = result.path
      document.getElementById('folder-path-input').value = result.path
      document.getElementById('start-export-btn').disabled = false
      // Persist export folder path on the PRD record
      await amc.db.update('prds', currentPrd.id, { export_folder: result.path })
    }
  })

  // Start export
  document.getElementById('start-export-btn').addEventListener('click', () => {
    if (!selectedExportFolder) return
    runDecomposerExport(step, stepDef)
  })
}

/** Run the full Decomposer export: file-by-file AI generation with real progress.
 *  Phase 1: AI plans the file list (quick call)
 *  Phase 2: For each file, AI generates content → written to disk immediately
 *  Phase 3: KICKOFF.md generated from template */
async function runDecomposerExport(step, stepDef) {
  const container = document.getElementById('messages')

  // Replace intro with progress panel
  container.innerHTML = ''
  const progress = document.createElement('div')
  progress.className = 'decomposer-progress'
  progress.innerHTML = `
    <div class="progress-header">
      <div class="export-spinner"></div>
      <span id="export-status">Planning file structure...</span>
    </div>
    <p class="progress-subtitle">Each file is generated and written individually. This will take several minutes.</p>
    <div id="file-list" class="export-file-list"></div>
    <div id="export-complete" class="export-complete hidden"></div>
  `
  container.appendChild(progress)

  try {
    // Build the Decomposer prompt with ALL context from steps 1-12
    const systemPrompt = await buildSystemPrompt(step, stepDef)

    const planningPrompt =
      `You are the Decomposer for "${currentPrd.title}". ` +
      `Based on the complete PRD context from all 12 steps, plan the file structure.\n\n` +
      `List ONLY the filenames you will generate, one per line. Use the format:\n` +
      `00_README.md\n01_Auth.md\n02_Database_Schema.md\n...\n\n` +
      `Rules:\n` +
      `- Start with foundation: 00_README.md, 01_Auth.md, 02_Database_Schema.md, 03_API_Endpoints.md, 04_UI_Design_System.md\n` +
      `- Then features in build order: 05_Feature.md, 06_Feature.md, etc.\n` +
      `- End with XX_Future_Features.md for deferred items\n` +
      `- Target 15-25 files total\n` +
      `- Output ONLY filenames, no descriptions or commentary`

    // Phase 1: Get file plan
    updateExportStatus('Planning file structure...')
    const result = await amc.session.create({ prompt: systemPrompt + '\n\n---\n\n' + planningPrompt })
    currentSessionId = result.sessionId
    persistStepSession(step.id, currentSessionId)

    const planResponse = await waitForSessionResponse(currentSessionId, 120000)
    const fileNames = parsePlannedFileNames(planResponse)

    if (fileNames.length === 0) {
      throw new Error('AI did not return any filenames. Please try again.')
    }

    // Show all planned files as pending
    showPendingFileList(fileNames)

    // Phase 2: Generate each file one at a time
    const completedFiles = []
    let allContent = ''

    // Clear any existing prd_files from a previous export attempt (re-export)
    await amc.db.deleteWhere('prd_files', { prd_id: currentPrd.id })

    for (let i = 0; i < fileNames.length; i++) {
      const fileName = fileNames[i]
      updateExportStatus(`Generating ${fileName}... (${i + 1} of ${fileNames.length + 1})`)

      const filePrompt =
        `Generate the complete content for \`${fileName}\`.\n\n` +
        `Rules:\n` +
        `- Output ONLY the raw markdown content for this file\n` +
        `- Do NOT include the filename as a header\n` +
        `- Do NOT include commentary before or after the content\n` +
        `- Include sections: Overview, Dependencies, main content, Gaps & Assumptions\n` +
        `- Target 150-250 lines\n` +
        `- Reference other files by name when relevant (e.g. "See 02_Database_Schema.md")\n` +
        `- Be specific and implementation-ready`

      try {
        const content = await sendAndWaitForResponse(currentSessionId, filePrompt, 300000)
        allContent += `## ${fileName}\n\n${content}\n\n`

        // Write to disk IMMEDIATELY
        await amc.export.writeFiles({
          directory: selectedExportFolder,
          files: [{ name: `docs/planning/${fileName}`, content }],
        })

        completedFiles.push({ name: fileName, content })
        markFileDone(fileName)

        // Save to prd_files for the file browser
        await amc.db.insert('prd_files', {
          prd_id: currentPrd.id,
          file_name: fileName,
          display_name: fileNameToDisplayName(fileName),
          content,
          order: i,
        })
      } catch (err) {
        console.error(`[PRDStack] Failed to generate ${fileName}:`, err)
        markFileFailed(fileName)
        // Continue with next file — don't let one failure stop the whole export
      }
    }

    // Phase 3: KICKOFF.md (template — no AI needed)
    updateExportStatus(`Writing KICKOFF.md... (${fileNames.length + 1} of ${fileNames.length + 1})`)
    const kickoff = generateKickoffPrompt(currentPrd.title, completedFiles.map((f) => f.name))
    await amc.export.writeFiles({
      directory: selectedExportFolder,
      files: [{ name: 'KICKOFF.md', content: kickoff }],
    })
    markFileDone('KICKOFF.md')

    // Save KICKOFF.md to prd_files too
    await amc.db.insert('prd_files', {
      prd_id: currentPrd.id,
      file_name: 'KICKOFF.md',
      display_name: 'KICKOFF',
      content: kickoff,
      order: fileNames.length,
    })

    // Save to plugin DB
    await amc.db.insert('messages', {
      step_id: step.id,
      prd_id: currentPrd.id,
      role: 'assistant',
      content: allContent,
    })

    // Show file browser instead of old success screen
    await showFileBrowser(currentPrd.id)

    // Auto-complete the step
    await saveAndCompleteDecomposer(step, allContent, completedFiles)
  } catch (err) {
    console.error('[PRDStack] Decomposer generation failed:', err)
    document.getElementById('export-status').textContent = 'Generation failed'
    document.querySelector('.export-spinner')?.remove()
    document.getElementById('export-complete').innerHTML = `
      <div class="export-error">
        <p>Something went wrong: ${escapeHtml(err.message || String(err))}</p>
        <button class="btn btn-primary btn-sm" onclick="location.reload()">Try Again</button>
      </div>
    `
    document.getElementById('export-complete').classList.remove('hidden')
  }
}

// -- Decomposer Helpers ------------------------------------------------------

/** Wait for the first assistant response from a session */
async function waitForSessionResponse(sessionId, timeoutMs) {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const statusResult = await amc.session.getStatus(sessionId)
    const status = statusResult.status
    const msgs = await amc.session.getMessages(sessionId)
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant')

    if (assistantMsgs.length > 0 && status !== 'running' && status !== 'starting') {
      return assistantMsgs[assistantMsgs.length - 1].content
    }
    if (status === 'error') throw new Error('AI session errored')
    if (status === 'ended' && assistantMsgs.length === 0) throw new Error('AI session ended without responding')
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)
}

/** Send a follow-up message and wait for the AI response */
async function sendAndWaitForResponse(sessionId, text, timeoutMs) {
  const beforeMsgs = await amc.session.getMessages(sessionId)
  const beforeCount = beforeMsgs.filter((m) => m.role === 'assistant').length

  await amc.session.sendMessage(sessionId, { text })

  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const statusResult = await amc.session.getStatus(sessionId)
    const status = statusResult.status
    const msgs = await amc.session.getMessages(sessionId)
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant')

    if (assistantMsgs.length > beforeCount && status !== 'running' && status !== 'starting') {
      return assistantMsgs[assistantMsgs.length - 1].content
    }
    if (status === 'error') throw new Error('AI session errored')
    if (status === 'ended' && assistantMsgs.length <= beforeCount) throw new Error('AI session ended without responding')
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)
}

/** Parse the AI's planning response into a list of filenames */
function parsePlannedFileNames(text) {
  const names = []
  const pattern = /\d{2}[a-z]?_[\w]+\.md/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (!names.includes(match[0])) names.push(match[0])
  }
  console.log('[PRDStack] Planned files:', names)
  return names
}

/** Show all planned files as pending in the progress UI */
function showPendingFileList(fileNames) {
  const fileListEl = document.getElementById('file-list')
  fileListEl.innerHTML = ''

  for (const name of [...fileNames, 'KICKOFF.md']) {
    const item = document.createElement('div')
    item.className = 'export-file-item pending'
    item.id = `file-item-${name}`
    item.innerHTML = `
      <span class="file-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
        </svg>
      </span>
      <span class="file-name">${escapeHtml(name)}</span>
    `
    fileListEl.appendChild(item)
  }
}

function updateExportStatus(text) {
  const el = document.getElementById('export-status')
  if (el) el.textContent = text
}

function markFileDone(fileName) {
  const item = document.getElementById(`file-item-${fileName}`)
  if (!item) return
  item.className = 'export-file-item done'
  item.querySelector('.file-icon').innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  `
  // Scroll to keep current file visible
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function markFileFailed(fileName) {
  const item = document.getElementById(`file-item-${fileName}`)
  if (!item) return
  item.className = 'export-file-item failed'
  item.querySelector('.file-icon').innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  `
}

/** Convert "09_Pet_Profiles.md" → "Pet Profiles" */
function fileNameToDisplayName(fileName) {
  return fileName
    .replace(/\.md$/, '')           // strip extension
    .replace(/^\d{2}[a-z]?_/, '')   // strip numeric prefix (e.g. "09_", "05a_")
    .replace(/_/g, ' ')             // underscores → spaces
}

function showExportComplete(successCount, totalCount) {
  updateExportStatus(`Done! ${successCount} files written`)
  document.querySelector('.export-spinner')?.remove()
  document.querySelector('.progress-subtitle')?.remove()

  const failCount = totalCount - successCount
  const failNote = failCount > 0 ? `<p class="export-warning">${failCount} file(s) failed — you can regenerate them later.</p>` : ''

  const completeEl = document.getElementById('export-complete')
  completeEl.innerHTML = `
    <div class="export-success">
      <p><strong>${successCount} PRD files</strong> + <strong>KICKOFF.md</strong> written to:</p>
      <code>${escapeHtml(selectedExportFolder)}/docs/planning/</code>
      ${failNote}
      <p class="export-next-step">Open <code>KICKOFF.md</code> in Claude Code to start building.</p>
    </div>
  `
  completeEl.classList.remove('hidden')
}

/** Render the file browser view for a completed Decomposer step */
async function showFileBrowser(prdId) {
  const files = await amc.db.query('prd_files', {
    where: { prd_id: prdId },
    orderBy: { order: 'asc' },
  })
  const prd = await amc.db.getById('prds', prdId)
  const exportFolder = prd?.export_folder || ''

  const container = document.getElementById('messages')
  container.innerHTML = ''

  // Hide input area — file browser doesn't need it
  const inputArea = document.querySelector('.input-area')
  if (inputArea) inputArea.style.display = 'none'

  // Handle legacy PRDs with no prd_files (completed before this feature)
  if (files.length === 0) {
    container.innerHTML = `
      <div class="decomposer-progress" style="text-align: center; padding: 60px 20px;">
        <p style="color: var(--surface-500); font-size: 14px;">No files were saved during export.</p>
        ${exportFolder ? `<p style="color: var(--surface-400); font-size: 12px; margin-top: 8px;">Files may exist at: <code>${escapeHtml(exportFolder)}/docs/planning/</code></p>` : ''}
      </div>
    `
    return
  }

  // Build the two-panel file browser
  const browser = document.createElement('div')
  browser.className = 'file-browser'

  // -- Completion banner --
  const relativePath = 'docs/planning/'
  const banner = document.createElement('div')
  banner.className = 'file-browser-banner'
  banner.innerHTML = `
    <div class="file-browser-banner-content">
      <div class="file-browser-banner-left">
        <svg class="file-browser-banner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span class="file-browser-banner-text">PRD Complete — ${files.length} files generated</span>
      </div>
      <div class="file-browser-banner-actions">
        ${exportFolder ? `
          <button class="btn btn-ghost btn-sm file-browser-open-btn" id="open-explorer-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            Open in Explorer
          </button>
        ` : ''}
        <button class="btn btn-primary btn-sm hidden" id="build-this-now-banner-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Build This Now
        </button>
        <span class="build-this-now-fallback hidden" id="build-this-now-banner-fallback">
          Files not found — re-export to build
        </span>
      </div>
    </div>
    ${exportFolder ? `<div class="file-browser-banner-path">${escapeHtml(relativePath)}</div>` : ''}
  `
  browser.appendChild(banner)

  // -- Two-panel layout --
  const panels = document.createElement('div')
  panels.className = 'file-browser-panels'

  // Left: file list
  const fileList = document.createElement('div')
  fileList.className = 'file-browser-list'

  for (const file of files) {
    const item = document.createElement('div')
    item.className = 'file-browser-item'
    item.dataset.fileId = file.id
    item.innerHTML = `
      <svg class="file-browser-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="file-browser-item-name">${escapeHtml(file.display_name)}</span>
    `
    item.addEventListener('click', () => selectFile(file, item))
    fileList.appendChild(item)
  }

  // Build This Now in sidebar
  const sidebarAction = document.createElement('div')
  sidebarAction.className = 'file-browser-sidebar-action'
  sidebarAction.innerHTML = `
    <button class="btn btn-primary btn-sm hidden" id="build-this-now-sidebar-btn" style="width: 100%;">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Build This Now
    </button>
    <span class="build-this-now-fallback hidden" id="build-this-now-sidebar-fallback" style="font-size: 11px; color: var(--surface-500); text-align: center; display: block; padding: 8px 4px;">
      Files not found — re-export to build
    </span>
  `
  fileList.appendChild(sidebarAction)

  panels.appendChild(fileList)

  // Right: markdown viewer
  const viewer = document.createElement('div')
  viewer.className = 'file-browser-viewer'
  viewer.id = 'file-viewer'
  viewer.innerHTML = '<div class="file-browser-empty">Select a file to view its contents.</div>'
  panels.appendChild(viewer)

  browser.appendChild(panels)
  container.appendChild(browser)

  // Wire up "Open in Explorer" button
  if (exportFolder) {
    document.getElementById('open-explorer-btn')?.addEventListener('click', () => {
      amc.export.openFolder({ path: exportFolder })
    })
  }

  // Wire up Build This Now buttons
  document.getElementById('build-this-now-banner-btn')?.addEventListener('click', handleBuildThisNow)
  document.getElementById('build-this-now-sidebar-btn')?.addEventListener('click', handleBuildThisNow)

  // Auto-select first file
  const firstItem = fileList.querySelector('.file-browser-item')
  if (firstItem && files.length > 0) {
    selectFile(files[0], firstItem)
  }

  // Check disk and show/hide Build This Now button
  await updateBuildThisNowUI()
}

/** Build This Now: verify disk -> find/create project -> launch session with KICKOFF.md */
async function handleBuildThisNow() {
  const folderOk = currentPrd && currentPrd.export_folder &&
    (currentPrd.export_folder.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(currentPrd.export_folder))
  if (!folderOk) {
    amc.toast.show({ type: 'info', message: 'Click "Export PRD Files" first to set a project folder, then Build This Now will work.' })
    return
  }

  try {
    // Step 1: Verify files exist on disk
    const verification = await amc.export.verifyFiles({
      directory: currentPrd.export_folder,
      files: ['KICKOFF.md', 'docs/planning']
    })

    if (!verification.verified) {
      amc.toast.show({
        type: 'warning',
        message: 'PRD files not found at original location — re-export to enable Build This Now'
      })
      return
    }

    const kickoffContent = verification.kickoffContent
    if (!kickoffContent) {
      amc.toast.show({ type: 'error', message: 'KICKOFF.md is empty or could not be read' })
      return
    }

    // Step 2: Check if a project already exists for this folder
    const existingProject = await amc.project.findByFolder(currentPrd.export_folder)

    let projectId
    if (existingProject) {
      projectId = existingProject.id
    } else {
      // Step 3: Open Add Project dialog with folder pre-selected
      const result = await amc.project.openAddDialog({ preselectedFolder: currentPrd.export_folder })
      if (result.cancelled) return
      projectId = result.projectId
    }

    if (!projectId) {
      amc.toast.show({ type: 'error', message: 'Failed to resolve project' })
      return
    }

    // Step 4: Launch session with KICKOFF.md as draft
    await amc.session.launchWithDraft({
      projectId,
      draftText: kickoffContent
    })

    amc.toast.show({ type: 'success', message: 'Session created with kickoff prompt — review and send!' })
  } catch (err) {
    console.error('[PRDStack] Build This Now failed:', err)
    amc.toast.show({ type: 'error', message: `Build This Now failed: ${err.message || err}` })
  }
}

/** Check disk and update Build This Now button/fallback visibility */
async function updateBuildThisNowUI() {
  if (!currentPrd || currentPrd.status !== 'completed' || !currentPrd.export_folder) {
    buildThisNowVerified = null
    return
  }

  try {
    const verification = await amc.export.verifyFiles({
      directory: currentPrd.export_folder,
      files: ['KICKOFF.md', 'docs/planning']
    })
    buildThisNowVerified = verification.verified
  } catch {
    buildThisNowVerified = false
  }

  // Update banner button
  const bannerBtn = document.getElementById('build-this-now-banner-btn')
  const bannerFallback = document.getElementById('build-this-now-banner-fallback')
  if (bannerBtn) bannerBtn.classList.toggle('hidden', !buildThisNowVerified)
  if (bannerFallback) bannerFallback.classList.toggle('hidden', buildThisNowVerified)

  // Update sidebar button
  const sidebarBtn = document.getElementById('build-this-now-sidebar-btn')
  const sidebarFallback = document.getElementById('build-this-now-sidebar-fallback')
  if (sidebarBtn) sidebarBtn.classList.toggle('hidden', !buildThisNowVerified)
  if (sidebarFallback) sidebarFallback.classList.toggle('hidden', buildThisNowVerified !== false)
}

/** Select a file in the browser and render its markdown content */
function selectFile(file, itemEl) {
  // Update active state on list items
  document.querySelectorAll('.file-browser-item').forEach((el) => el.classList.remove('active'))
  itemEl.classList.add('active')

  // Render markdown in viewer
  const viewer = document.getElementById('file-viewer')
  if (!viewer) return
  viewer.innerHTML = `
    <div class="file-browser-doc">
      <div class="file-browser-doc-header">${escapeHtml(file.display_name)}</div>
      <div class="file-browser-doc-body">${renderMarkdown(file.content)}</div>
    </div>
  `
  viewer.scrollTop = 0
}

/** Save Decomposer content and complete the step + PRD */
async function saveAndCompleteDecomposer(step, content, files) {
  // Save step content
  const contextSummary = files.length > 0
    ? `Decomposed into ${files.length} files: ${files.map((f) => f.name).join(', ')}`
    : content.slice(0, 500)

  await amc.db.update('steps', step.id, {
    is_completed: 1,
    generated_content: content,
    context_summary: contextSummary,
  })

  // Stop session
  if (currentSessionId) {
    amc.session.stop(currentSessionId).catch(() => {})
    currentSessionId = null
  }

  // Update PRD as completed
  await amc.db.update('prds', currentPrd.id, {
    current_step: V3_STEPS.length,
    progress: 100,
    status: 'completed',
  })

  needsYouPrdIds.delete(currentPrd.id)
  pushSidebarItems()
  amc.toast.show({ type: 'success', message: `PRD complete! ${files.length} files exported.` })
}

// -- System Prompt Builder ---------------------------------------------------

/** Build the full system prompt for the CLI session */
async function buildSystemPrompt(step, stepDef) {
  const masterPrompt = await amc.assets.readFile('prompts/v3/master_system_prompt.md')
  const stepPrompt = await amc.assets.readFile(`prompts/v3/${stepDef.file}`)

  // Build project context from completed steps
  const completedSteps = await amc.db.query('steps', {
    where: { prd_id: currentPrd.id, is_completed: 1 },
    orderBy: { order: 'asc' },
  })

  const contextBlock = completedSteps
    .filter((s) => s.context_summary)
    .map((s) => `Step ${s.order} -- ${s.title}:\n${s.context_summary}`)
    .join('\n\n')

  const convergenceInstruction = getConvergenceInstruction(roundCount + 1, stepDef.maxRounds)

  let fullPrompt = masterPrompt
    .replace('{{stepNumber}}', String(step.order))
    .replace('{{totalSteps}}', String(V3_STEPS.length))
    .replace('{{stepTitle}}', step.title)
    .replace('{{phase}}', step.phase)
    .replace('{{projectContext}}', contextBlock
      ? `<project_context>\n${contextBlock}\n</project_context>`
      : '')
    .replace('{{scopeDescription}}', step.title)
    .replace('{{offLimitsFormatted}}', V3_STEPS
      .filter((s) => s.order !== step.order)
      .map((s) => s.title)
      .join(', '))
    .replace('{{currentRound}}', String(roundCount + 1))
    .replace('{{maxRounds}}', String(stepDef.maxRounds))
    .replace('{{convergenceInstruction}}', convergenceInstruction)

  fullPrompt += '\n\n---\n\n' + stepPrompt

  // For the Decomposer (final step), inject file export context so the AI
  // doesn't waste rounds asking about file locations — that's handled by the app.
  if (stepDef.order === V3_STEPS.length) {
    fullPrompt += '\n\n---\n\n' +
      'IMPORTANT — FILE EXPORT IS HANDLED AUTOMATICALLY:\n' +
      'When this step completes, the app will automatically:\n' +
      '1. Show a folder picker (defaulting to the user\'s configured Projects folder)\n' +
      '2. Write all PRD files to `docs/planning/` inside the chosen folder\n' +
      '3. Generate a KICKOFF.md prompt in the project root\n\n' +
      'You do NOT need to ask about:\n' +
      '- File locations, directory structure, or where to save files\n' +
      '- Whether the user wants a kickoff prompt\n' +
      '- File naming conventions (the app enforces 00_Name.md format)\n\n' +
      'YOUR JOB: Focus entirely on generating the FILE CONTENT.\n' +
      'For each file, output the filename as a markdown header: ## 00_README.md\n' +
      'Then write the full file content below it.\n' +
      'Present files in batches of 5. Wait for user approval between batches.\n' +
      'Target 20-40 files, each 100-400 lines. Foundation files first (README, Auth, Database, API, UI Design), then features in build order.'
  }

  return fullPrompt
}

// -- Polling for CLI session output ------------------------------------------
let messageCountAtPollStart = 0
let pollStartTime = 0
let shownLongWaitToast = false
const LONG_WAIT_MS = 60000 // Show "still working" toast after 60s
const DEAD_SESSION_TIMEOUT_MS = 30000 // Only timeout if session is NOT running for 30s

function startPolling() {
  if (pollTimer) return
  isWaitingForResponse = true
  messageCountAtPollStart = lastMessageCount
  pollStartTime = Date.now()
  shownLongWaitToast = false
  updateSendButton()

  pollTimer = setInterval(async () => {
    if (!currentSessionId) return

    try {
      // Get current session status
      const statusResult = await amc.session.getStatus(currentSessionId)
      const status = statusResult.status

      // Get all messages from the CLI session
      const cliMessages = await amc.session.getMessages(currentSessionId)

      // Filter to only assistant messages (skip system, operator)
      const assistantMessages = cliMessages.filter((m) => m.role === 'assistant')

      const receivedNewMessage = assistantMessages.length > messageCountAtPollStart

      if (assistantMessages.length > lastMessageCount) {
        // New assistant message(s) arrived
        hideThinking()

        for (let i = lastMessageCount; i < assistantMessages.length; i++) {
          const msg = assistantMessages[i]
          // Save to plugin DB
          await amc.db.insert('messages', {
            step_id: currentStep.id,
            prd_id: currentPrd.id,
            role: 'assistant',
            content: msg.content,
          })
          appendMessage('assistant', msg.content)
          lastAssistantContent = msg.content
          roundCount++ // Count completed round (assistant responded)
        }
        lastMessageCount = assistantMessages.length
        updateRoundCounter()
      }

      // Stop conditions:
      // - ended/error: always stop (session is dead)
      // - needs_you/ready: only stop if we've received a new message since polling started,
      //   otherwise the status is stale from the previous turn (CLI hasn't transitioned yet)
      const shouldStop =
        status === 'ended' || status === 'error' ||
        ((status === 'needs_you' || status === 'ready') && receivedNewMessage)

      // Process-aware timeout: only give up if the session is NOT actively running.
      // If the CLI is still 'running', the AI is working — keep waiting.
      const elapsed = Date.now() - pollStartTime
      const processStillRunning = status === 'running' || status === 'starting'
      const timedOut = !receivedNewMessage && !processStillRunning &&
        elapsed > DEAD_SESSION_TIMEOUT_MS

      // Show a reassurance toast at 60s — the AI is still working, be patient
      if (!shownLongWaitToast && processStillRunning && elapsed > LONG_WAIT_MS) {
        shownLongWaitToast = true
        updateThinkingMessage('Still thinking — longer steps take more time...')
      }

      if (shouldStop || timedOut) {
        stopPolling()
        hideThinking() // Always clear thinking indicator when polling stops
        isWaitingForResponse = false

        // Auto-complete: the user clicked "Finalize" and the AI just delivered the document
        if (awaitingFinalization && receivedNewMessage) {
          awaitingFinalization = false
          await completeStep()
          return // completeStep navigates to next step
        }

        setInputEnabled(!currentStep.is_completed)
        removeCompletionCta()
        updateStepActions()

        // Update needs-you tracking for host sidebar
        if (receivedNewMessage && (status === 'needs_you' || status === 'ready') && currentPrd) {
          needsYouPrdIds.add(currentPrd.id)
          pushSidebarItems()
        }

        if (status === 'error') {
          awaitingFinalization = false
          amc.toast.show({ type: 'error', message: 'Session encountered an error. Try sending another message.' })
        }
        if ((status === 'ended') && !receivedNewMessage) {
          console.warn('[PRDStack] Session ended without responding. Session:', currentSessionId)
          currentSessionId = null // Force new session on next send
          awaitingFinalization = false
          amc.toast.show({ type: 'warning', message: 'The AI session expired. Send your message again to continue.' })
        }
        if (timedOut && !receivedNewMessage) {
          console.warn('[PRDStack] Poll timed out (session status:', status, '). Session:', currentSessionId)
          awaitingFinalization = false
          amc.toast.show({ type: 'warning', message: 'Response timed out. Try sending another message.' })
        }
      }
    } catch (err) {
      console.error('[PRDStack] Poll error:', err)
    }
  }, 800)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// -- Messaging ---------------------------------------------------------------
async function sendMessage() {
  const input = document.getElementById('user-input')
  const text = input.value.trim()
  if (!text || isWaitingForResponse) return

  input.value = ''
  input.style.height = 'auto'
  // roundCount increments in polling when AI actually responds (not on send)

  // Remove CTA if visible — user chose to keep chatting instead of completing.
  // It will re-appear at the bottom after the AI responds (via updateStepActions).
  removeCompletionCta()

  // Save user message to plugin DB
  await amc.db.insert('messages', {
    step_id: currentStep.id,
    prd_id: currentPrd.id,
    role: 'user',
    content: text,
  })
  appendMessage('user', text)

  // Auto-generate title from first user message (roundCount is 0 at this point — increments on AI response)
  if (currentPrd.title === 'Untitled PRD' && currentStep.order === 1 && roundCount === 0) {
    autoGenerateTitle(text)
  }

  // Update PRD status to in_progress
  if (currentPrd.status === 'draft') {
    await amc.db.update('prds', currentPrd.id, { status: 'in_progress' })
    currentPrd.status = 'in_progress'
  }

  showThinking()
  updateRoundCounter()

  // User is responding — clear needs-you flag for this PRD
  if (currentPrd) {
    needsYouPrdIds.delete(currentPrd.id)
    pushSidebarItems()
  }

  try {
    // Check if existing session is still alive — it may have timed out while user was away
    if (currentSessionId) {
      try {
        const statusResult = await amc.session.getStatus(currentSessionId)
        console.log('[PRDStack] sendMessage: session', currentSessionId, 'status:', statusResult.status)
        if (statusResult.status === 'ended' || statusResult.status === 'error') {
          console.log('[PRDStack] Session expired, will recreate with context')
          currentSessionId = null // Force recreation with full context
        }
      } catch (err) {
        console.warn('[PRDStack] Could not check session status, recreating:', err)
        currentSessionId = null
      }
    }

    if (!currentSessionId) {
      // No session (first message) or session died — create with full context
      console.log('[PRDStack] sendMessage: creating new session with full context')
      const stepDef = V3_STEPS.find((s) => s.order === currentStep.order)
      const systemPrompt = await buildSystemPrompt(currentStep, stepDef)

      // Include all prior messages for this step so the AI has full conversation history
      const priorMessages = await amc.db.query('messages', {
        where: { step_id: currentStep.id },
        orderBy: { created_at: 'asc' },
      })

      let contextBlock = ''
      if (priorMessages.length > 0) {
        contextBlock = '\n\n---\nPrior conversation in this step (resume seamlessly):\n'
        for (const msg of priorMessages) {
          contextBlock += `\n${msg.role === 'user' ? 'USER' : 'ASSISTANT'}: ${msg.content}\n`
        }
        contextBlock += '\n---\n\nThe user continues:\n'
      } else {
        contextBlock = '\n\n---\n\nThe user says:\n'
      }

      const fullPrompt = systemPrompt + contextBlock + text
      const result = await amc.session.create({ prompt: fullPrompt })
      currentSessionId = result.sessionId
      console.log('[PRDStack] sendMessage: new session created:', currentSessionId)
      // Persist session ID for recovery (fire-and-forget — must not block polling)
      persistStepSession(currentStep.id, currentSessionId)
    } else {
      // Session is alive — send directly
      console.log('[PRDStack] sendMessage: sending to live session', currentSessionId)
      await amc.session.sendMessage(currentSessionId, { text })
    }
    console.log('[PRDStack] sendMessage: starting polling, lastMessageCount:', lastMessageCount)
    startPolling()
  } catch (err) {
    hideThinking()
    isWaitingForResponse = false
    setInputEnabled(true)
    console.error('[PRDStack] Failed to send message:', err)
    amc.toast.show({ type: 'error', message: `Failed to send: ${err.message || err}` })
  }
}

async function autoGenerateTitle(userInput) {
  try {
    // Use AI service to generate a concise project title
    const title = await amc.ai.generateTitle(userInput)
    if (title && title !== 'Untitled PRD') {
      await updatePrdTitle(title)
    }
  } catch (err) {
    // Fallback: extract first sentence
    console.warn('[PRDStack] AI title generation failed, using fallback:', err)
    let title = userInput.split(/[.!?\n]/)[0].trim()
    if (title.length > 50) title = title.substring(0, 47) + '...'
    if (title.length < 3) title = 'New PRD'
    await updatePrdTitle(title)
  }
}

/** Update the PRD title in the plugin DB, the UI, and rename the CLI session to match */
async function updatePrdTitle(title) {
  await amc.db.update('prds', currentPrd.id, { title })
  currentPrd.title = title
  document.getElementById('prd-title').textContent = title
  // Also rename the AMC CLI session so it's identifiable if it shows up anywhere
  if (currentSessionId) {
    amc.session.rename(currentSessionId, `PRD: ${title}`).catch(() => {})
  }
  pushSidebarItems()
}

// -- Step Finalization (CTA triggers AI to write the final document) ---------
async function requestFinalization() {
  if (!currentStep || isWaitingForResponse) return

  const stepDef = V3_STEPS.find((s) => s.order === currentStep.order)
  if (!stepDef) return

  awaitingFinalization = true
  removeCompletionCta()
  setInputEnabled(false)

  const finalizationPrompt =
    `I'm satisfied with the information gathered. Please produce the final, polished ` +
    `${stepDef.title} document now. Synthesize everything we've discussed into a comprehensive, ` +
    `well-structured deliverable with clear headers and formatting. Do not ask any more questions.`

  // Save and display as a user message
  await amc.db.insert('messages', {
    step_id: currentStep.id,
    prd_id: currentPrd.id,
    role: 'user',
    content: finalizationPrompt,
  })
  appendMessage('user', finalizationPrompt)

  showThinking()

  try {
    // Reuse existing session or create a new one (same logic as sendMessage)
    if (currentSessionId) {
      try {
        const statusResult = await amc.session.getStatus(currentSessionId)
        if (statusResult.status === 'ended' || statusResult.status === 'error') {
          currentSessionId = null
        }
      } catch {
        currentSessionId = null
      }
    }

    if (!currentSessionId) {
      const systemPrompt = await buildSystemPrompt(currentStep, stepDef)
      const priorMessages = await amc.db.query('messages', {
        where: { step_id: currentStep.id },
        orderBy: { created_at: 'asc' },
      })

      let contextBlock = '\n\n---\nPrior conversation in this step (resume seamlessly):\n'
      for (const msg of priorMessages) {
        contextBlock += `\n${msg.role === 'user' ? 'USER' : 'ASSISTANT'}: ${msg.content}\n`
      }
      contextBlock += '\n---\n\nThe user continues:\n'

      const fullPrompt = systemPrompt + contextBlock + finalizationPrompt
      const result = await amc.session.create({ prompt: fullPrompt })
      currentSessionId = result.sessionId
      persistStepSession(currentStep.id, currentSessionId)
    } else {
      await amc.session.sendMessage(currentSessionId, { text: finalizationPrompt })
    }

    startPolling()
  } catch (err) {
    hideThinking()
    isWaitingForResponse = false
    awaitingFinalization = false
    setInputEnabled(true)
    console.error('[PRDStack] Finalization failed:', err)
    amc.toast.show({ type: 'error', message: `Failed to finalize: ${err.message || err}` })
  }
}

// -- Step Completion ---------------------------------------------------------
async function completeStep() {
  if (!currentStep) return

  // Get ALL assistant messages for this step — concat as the full generated content
  const messages = await amc.db.query('messages', {
    where: { step_id: currentStep.id, role: 'assistant' },
    orderBy: { created_at: 'asc' },
  })
  // Combine all assistant messages (matches PRDStack's Path B approach)
  const generatedContent = messages.map((m) => m.content).join('\n\n')
  // Use the last (most refined) assistant message as the context summary for future steps
  const contextSummary = messages.length > 0 ? messages[messages.length - 1].content : ''

  // Update step
  await amc.db.update('steps', currentStep.id, {
    is_completed: 1,
    generated_content: generatedContent,
    context_summary: contextSummary,
  })

  // Stop current session
  if (currentSessionId) {
    amc.session.stop(currentSessionId).catch(() => {})
    currentSessionId = null
  }
  stopPolling()

  // Update PRD progress
  const allSteps = await amc.db.query('steps', { where: { prd_id: currentPrd.id } })
  const completedCount = allSteps.filter((s) => s.is_completed).length
  const progress = Math.round((completedCount / allSteps.length) * 100)
  const nextStep = Math.min(currentStep.order + 1, V3_STEPS.length)
  const status = progress === 100 ? 'completed' : 'in_progress'

  await amc.db.update('prds', currentPrd.id, {
    current_step: nextStep,
    progress,
    status,
  })

  // After completing Product Vision (step 1), extract the AI-generated project name
  if (currentStep.order === 1 && generatedContent) {
    try {
      const title = await amc.ai.generateTitle(generatedContent)
      if (title && title !== 'Untitled PRD') {
        await updatePrdTitle(title)
      }
    } catch (err) {
      console.warn('[PRDStack] Failed to extract project name from vision:', err)
    }
  }

  // Clear needs-you flag since user just completed the step
  needsYouPrdIds.delete(currentPrd.id)
  amc.toast.show({ type: 'success', message: `Step completed: ${currentStep.title}` })
  pushSidebarItems()

  // Decomposer handles its own export flow — no need to call exportPrdFiles here

  if (status === 'completed') {
    // All steps done — show viewer
    await openViewer(currentPrd.id)
  } else {
    // Reload PRD to advance to next step
    await openPrd(currentPrd.id)
  }
}

// -- PRD File Export (Decomposer → disk) -------------------------------------

/** Parse the Decomposer's generated content into individual files.
 *  Looks for markdown headers that match the naming convention: ## 00_README.md */
function parseDecomposedFiles(content) {
  const files = []
  // Find all headers that look like filenames: ## 00_README.md or ### File: 00_README.md
  const pattern = /^#{1,3}\s+(?:File:\s*)?(\d{2}[a-z]?_[\w]+\.md)\s*$/gm
  let match
  const markers = []
  while ((match = pattern.exec(content)) !== null) {
    markers.push({ index: match.index, end: match.index + match[0].length, name: match[1] })
  }
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].end
    const end = i + 1 < markers.length ? markers[i + 1].index : content.length
    let body = content.slice(start, end).trim()
    // Remove trailing --- batch separators
    body = body.replace(/\n-{3,}\s*$/, '').trim()
    // Remove batch approval messages at the end (e.g., "Here's Batch 2...")
    body = body.replace(/\n(?:Here's \*?\*?Batch|Review and let me know|Approve all)[\s\S]*$/, '').trim()
    if (body) {
      files.push({ name: markers[i].name, content: body })
    }
  }
  console.log(`[PRDStack] parseDecomposedFiles: found ${files.length} files`, files.map((f) => f.name))
  return files
}

/** Generate the KICKOFF.md prompt that users give to Claude Code to start building */
function generateKickoffPrompt(projectTitle, fileNames) {
  // Build the numbered file reading plan
  const fileReadingPlan = fileNames
    .map((name, i) => `${i + 1}. Read \`docs/planning/${name}\``)
    .join('\n')

  // Identify foundation files (00-04) vs feature files (05+) vs future files
  const foundationFiles = []
  const featureFiles = []
  const futureFile = []
  for (const name of fileNames) {
    if (/future|deferred/i.test(name)) futureFile.push(name)
    else if (/^0[0-4][a-z]?_/.test(name)) foundationFiles.push(name)
    else featureFiles.push(name)
  }

  const foundationList = foundationFiles.length > 0
    ? foundationFiles.map((f) => `- \`docs/planning/${f}\``).join('\n')
    : '- `docs/planning/00_README.md`\n- `docs/planning/01_Auth.md`\n- `docs/planning/02_Database_Schema.md`'

  const featureList = featureFiles.length > 0
    ? featureFiles.map((f) => `- \`docs/planning/${f}\``).join('\n')
    : '- (feature files numbered 05+)'

  return `# ${projectTitle} — Implementation Kickoff

You are building **${projectTitle}** from a complete PRD (Product Requirements Document) that has been decomposed into focused, implementation-ready files. This prompt is your guide to turning that PRD into a working application.

## Your Role

You are the lead developer. The PRD files in \`docs/planning/\` contain everything you need: architecture decisions, business logic, data models, API designs, UI specifications, and domain rules. These files were written for a mid-to-senior developer — they tell you *what* to build and *why*, not *how* to write every line.

## Step 1: Read the Full PRD

Before writing a single line of code, read every PRD file in order. This is critical — the files build on each other and contain cross-references.

${fileReadingPlan}

Take notes on:
- The tech stack and architectural decisions (do NOT substitute frameworks or libraries)
- Data models and relationships between entities
- Dependencies between features (what must be built before what)
- Any "Gaps & Assumptions" sections — these flag areas where you may need to make judgment calls

## Step 2: Project Setup

After reading all PRD files:

1. Initialize the project with the tech stack specified in the README file
2. Set up the development environment, linting, and basic project structure
3. Create the database schema / data models as specified
4. Set up authentication if the project requires it
5. Commit this foundation before building any features

## Step 3: Build in Order

The PRD files are numbered by build sequence — **follow this order**. Each file lists its dependencies on other files.

**Foundation (build first):**
${foundationList}

**Features (build in numbered order):**
${featureList}
${futureFile.length > 0 ? `\n**Deferred (skip for now):**\n${futureFile.map((f) => '- `docs/planning/' + f + '`').join('\n')}\n\nThese are explicitly post-MVP. Do not implement them.` : ''}

For each feature file:
1. Re-read the specific PRD file before implementing
2. Build the data layer first (models, database operations)
3. Build the API/service layer next
4. Build the UI last
5. Test the feature before moving to the next file
6. Commit after each feature is complete

## Implementation Rules

- **Follow the PRD exactly.** The PRD captures specific business logic, domain rules, and architectural decisions made during extensive product planning. Do not override these unless you find a genuine technical impossibility.
- **Respect the tech stack.** Do not substitute frameworks, libraries, or databases. The tech stack was chosen deliberately.
- **Use suggested defaults.** When a PRD file says "default" or suggests a reasonable value for something underspecified, use it unless you have a strong technical reason not to.
- **Flag concerns, don't guess.** If something in the PRD is ambiguous or seems wrong, flag it and ask rather than silently making a different choice.
- **Keep files focused.** Mirror the PRD's modular structure in your code — one feature area per module/directory.
- **No gold-plating.** Build what the PRD specifies. Don't add extra features, over-engineer abstractions, or optimize prematurely.

## Get Started

Begin by reading \`docs/planning/${fileNames[0] || '00_README.md'}\`. Once you've read all ${fileNames.length} PRD files, set up the project and start building.
`
}

/** Export decomposed PRD files to disk after the Decomposer step completes */
async function exportPrdFiles(generatedContent) {
  try {
    // Parse the AI's output into individual files
    const files = parseDecomposedFiles(generatedContent)
    if (files.length === 0) {
      console.warn('[PRDStack] No decomposed files found in content — skipping export')
      return
    }

    // Show folder picker (defaults to the user's Default Projects Folder from app settings)
    const result = await amc.export.pickFolder({
      title: `Select project folder for "${currentPrd.title}"`,
    })
    if (!result.selected) {
      console.log('[PRDStack] User cancelled folder picker — skipping export')
      return
    }

    const projectFolder = result.path

    // Generate kickoff prompt referencing all PRD files
    const kickoff = generateKickoffPrompt(
      currentPrd.title,
      files.map((f) => f.name)
    )

    // Build the file list: PRD docs in docs/planning/, kickoff in root
    const allFiles = [
      ...files.map((f) => ({ name: `docs/planning/${f.name}`, content: f.content })),
      { name: 'KICKOFF.md', content: kickoff }
    ]

    // Write all files to disk
    await amc.export.writeFiles({ directory: projectFolder, files: allFiles })

    amc.toast.show({
      type: 'success',
      message: `Exported ${files.length} PRD files + KICKOFF.md to ${projectFolder}`
    })
    console.log(`[PRDStack] Exported ${allFiles.length} files to ${projectFolder}`)
  } catch (err) {
    console.error('[PRDStack] File export failed:', err)
    amc.toast.show({
      type: 'error',
      message: `Export failed: ${err.message || err}. PRD is still saved — you can export later from the viewer.`
    })
  }
}

// -- Viewer (Completed PRD) --------------------------------------------------
async function openViewer(prdId) {
  currentPrd = await amc.db.getById('prds', prdId)
  if (!currentPrd) return

  const steps = await amc.db.query('steps', {
    where: { prd_id: prdId },
    orderBy: { order: 'asc' }
  })

  showView('viewer-view')
  document.getElementById('viewer-title').textContent = currentPrd.title

  // Show Build This Now — disabled with hint if no valid export folder
  const buildBtn = document.getElementById('viewer-build-btn')
  if (buildBtn) {
    buildBtn.classList.remove('hidden')
    const hasValidExport = currentPrd.export_folder &&
      (currentPrd.export_folder.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(currentPrd.export_folder))
    if (hasValidExport) {
      buildBtn.disabled = false
      buildBtn.title = ''
      buildBtn.style.opacity = ''
    } else {
      buildBtn.disabled = true
      buildBtn.title = 'Export PRD Files first to enable Build This Now'
      buildBtn.style.opacity = '0.5'
    }
  }

  // Build section navigation
  const nav = document.getElementById('viewer-nav')
  nav.innerHTML = ''
  steps.forEach((step, i) => {
    const li = document.createElement('li')
    li.textContent = step.title
    li.addEventListener('click', () => {
      nav.querySelectorAll('li').forEach((el) => el.classList.remove('active'))
      li.classList.add('active')
      scrollToSection(i)
    })
    if (i === 0) li.classList.add('active')
    nav.appendChild(li)
  })

  // Build content
  const content = document.getElementById('viewer-content')
  content.innerHTML = `<h1>${escapeHtml(currentPrd.title)}</h1>`

  for (const step of steps) {
    const section = document.createElement('div')
    section.className = 'viewer-section'
    section.id = `section-${step.order}`
    section.innerHTML = `
      <h2>${escapeHtml(step.title)}</h2>
      ${step.generated_content ? renderMarkdown(step.generated_content) : '<p style="color: var(--surface-500)">No content generated for this step.</p>'}
    `
    content.appendChild(section)
  }
}

function scrollToSection(index) {
  const section = document.getElementById(`section-${index + 1}`)
  if (section) section.scrollIntoView({ behavior: 'smooth' })
}

async function exportPrds(opts = {}) {
  if (!currentPrd) return
  const { fromBuildThisNow = false } = opts

  // Check for decomposed files first (from Decomposer step), fall back to step content
  const prdFiles = await amc.db.query('prd_files', {
    where: { prd_id: currentPrd.id },
    orderBy: { order: 'asc' },
  })

  let filesToExport = []
  let description = ''

  if (prdFiles.length > 0) {
    // Use decomposed implementation files
    filesToExport = prdFiles.map((f) => ({
      name: `docs/planning/${f.file_name}`,
      content: f.content,
    }))
    description = fromBuildThisNow
      ? `Select the project folder where your PRD files are (or should be). If files already exist they will be updated; otherwise <strong>${prdFiles.length} files</strong> + <code>KICKOFF.md</code> will be created.`
      : `This will write <strong>${prdFiles.length} implementation files</strong> to <code>docs/planning/</code> inside your chosen project folder, plus a <code>KICKOFF.md</code> build guide.`
  } else {
    // Fall back to step content using V3_STEPS filenames
    const steps = await amc.db.query('steps', {
      where: { prd_id: currentPrd.id },
      orderBy: { order: 'asc' },
    })
    const stepsWithContent = steps.filter((s) => s.generated_content)
    filesToExport = stepsWithContent.map((s) => {
      const stepDef = V3_STEPS.find((d) => d.order === s.order)
      return {
        name: `docs/planning/${stepDef?.file || `${String(s.order).padStart(3, '0')}_${s.title.replace(/\s+/g, '_')}.md`}`,
        content: s.generated_content,
      }
    })
    description = fromBuildThisNow
      ? `Select the project folder where your PRD files are (or should be). If files already exist they will be updated; otherwise <strong>${filesToExport.length} files</strong> + <code>KICKOFF.md</code> will be created.`
      : `This will write <strong>${filesToExport.length} PRD step files</strong> to <code>docs/planning/</code> inside your chosen project folder, plus a <code>KICKOFF.md</code> build guide.`
  }

  if (filesToExport.length === 0) {
    amc.toast.show({ type: 'error', message: 'No content to export — PRD has no generated content.' })
    return
  }

  // Show export dialog
  const dialogTitle = fromBuildThisNow ? 'Select Project Folder' : 'Export PRD Files'
  const dialogHint = fromBuildThisNow
    ? 'Point to the root folder of your project so Build This Now knows where to find it.'
    : 'Choose the root folder of your project. Files will be created inside it.'
  const result = await showExportDialog(description, currentPrd.export_folder || '', dialogTitle, dialogHint)
  if (!result) return // user cancelled

  const projectFolder = result.folder

  // Generate KICKOFF.md
  const fileNames = filesToExport.map((f) => f.name.replace('docs/planning/', ''))
  const kickoff = generateKickoffPrompt(currentPrd.title, fileNames)
  const allFiles = [...filesToExport, { name: 'KICKOFF.md', content: kickoff }]

  try {
    await amc.export.writeFiles({ directory: projectFolder, files: allFiles })
    await amc.db.update('prds', currentPrd.id, { export_folder: projectFolder })
    currentPrd.export_folder = projectFolder

    amc.toast.show({
      type: 'success',
      message: `Exported ${filesToExport.length} files + KICKOFF.md`,
    })

    // Re-enable Build This Now now that files exist on disk
    const buildBtn = document.getElementById('viewer-build-btn')
    if (buildBtn) {
      buildBtn.classList.remove('hidden')
      buildBtn.disabled = false
      buildBtn.title = ''
      buildBtn.style.opacity = ''
    }
  } catch (err) {
    amc.toast.show({ type: 'error', message: `Export failed: ${err.message || err}` })
  }
}

/** Show a dialog for Export PRD Files — explains what will happen + folder picker */
function showExportDialog(description, defaultFolder, title = 'Export PRD Files', hint = 'Choose the root folder of your project. Files will be created inside it.') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'confirm-overlay'
    overlay.innerHTML = `
      <div class="confirm-dialog export-dialog">
        <h3>${escapeHtml(title)}</h3>
        <p>${description}</p>
        <p class="export-dialog-hint">${escapeHtml(hint)}</p>
        <div class="decomposer-folder-section">
          <label>Project Folder</label>
          <div class="folder-picker-row">
            <input type="text" class="folder-path-input" id="export-dialog-folder" placeholder="Select a folder..." value="${escapeHtml(defaultFolder)}" readonly />
            <button class="btn btn-secondary btn-sm" id="export-dialog-browse">Browse...</button>
          </div>
        </div>
        <div class="confirm-actions">
          <button class="btn btn-secondary btn-sm" id="export-dialog-cancel">Cancel</button>
          <button class="btn btn-primary btn-sm" id="export-dialog-export" ${defaultFolder ? '' : 'disabled'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export Files
          </button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)

    let selectedFolder = defaultFolder

    const cleanup = (result) => {
      overlay.remove()
      resolve(result)
    }

    overlay.querySelector('#export-dialog-browse').addEventListener('click', async () => {
      const result = await amc.export.pickFolder({
        title: `Select project folder for "${currentPrd.title}"`,
      })
      if (result.selected) {
        selectedFolder = result.path
        overlay.querySelector('#export-dialog-folder').value = result.path
        overlay.querySelector('#export-dialog-export').disabled = false
      }
    })

    overlay.querySelector('#export-dialog-cancel').addEventListener('click', () => cleanup(null))
    overlay.querySelector('#export-dialog-export').addEventListener('click', () => {
      if (selectedFolder) cleanup({ folder: selectedFolder })
    })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null) })
  })
}

/** Build This Now from the viewer — verify disk, find/create project, launch session */
async function handleBuildThisNowFromViewer() {
  if (!currentPrd) return

  // Check for valid absolute export_folder — relative paths (e.g. bare project name
  // from early autopilot runs) are treated as missing.
  const hasValidFolder = currentPrd.export_folder &&
    (currentPrd.export_folder.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(currentPrd.export_folder))
  if (!hasValidFolder) {
    amc.toast.show({
      type: 'info',
      message: 'Click "Export PRD Files" first to set a project folder, then Build This Now will work.'
    })
    return
  }

  // Verify files exist on disk
  const prdFiles = await amc.db.query('prd_files', {
    where: { prd_id: currentPrd.id },
    orderBy: { order: 'asc' },
  })
  const fileNames = prdFiles.length > 0
    ? prdFiles.map((f) => f.file_name)
    : V3_STEPS.map((s) => s.file)

  try {
    const verification = await amc.export.verifyFiles({
      directory: currentPrd.export_folder,
      files: ['KICKOFF.md', ...fileNames.map((f) => `docs/planning/${f}`)],
    })

    if (!verification.verified) {
      amc.toast.show({
        type: 'warning',
        message: 'Some PRD files are missing — re-export with "Export PRD Files" first.',
      })
      return
    }

    // Find or create AMC project for this folder
    const existingProject = await amc.project.findByFolder(currentPrd.export_folder)

    let projectId
    if (existingProject) {
      projectId = existingProject.id
    } else {
      // Open Add Project dialog with folder pre-selected
      const result = await amc.project.openAddDialog({ preselectedFolder: currentPrd.export_folder })
      if (!result || !result.projectId) {
        // User cancelled
        return
      }
      projectId = result.projectId
    }

    // Launch session with KICKOFF.md content as draft
    const kickoffContent = verification.kickoffContent || ''
    await amc.session.launchWithDraft({
      projectId,
      draftText: kickoffContent,
    })
  } catch (err) {
    console.error('[PRDStack] Build This Now failed:', err)
    amc.toast.show({ type: 'error', message: `Build This Now failed: ${err.message || err}` })
  }
}

// -- Rendering Helpers -------------------------------------------------------
function renderMessages(messages) {
  const container = document.getElementById('messages')
  container.innerHTML = ''
  for (const msg of messages) {
    appendMessage(msg.role, msg.content)
  }
}

function appendMessage(role, content) {
  const container = document.getElementById('messages')
  const div = document.createElement('div')
  div.className = `message ${role}`
  div.innerHTML = `
    <div class="message-label">${role === 'assistant' ? 'PRD Stack' : 'You'}</div>
    <div class="message-bubble">${role === 'assistant' ? renderMarkdown(content) : escapeHtml(content)}</div>
  `
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

function showThinking() {
  const container = document.getElementById('messages')
  // Remove existing thinking indicator
  hideThinking()
  const div = document.createElement('div')
  div.className = 'thinking-indicator'
  div.id = 'thinking'
  div.innerHTML = `
    <div class="thinking-dots"><span></span><span></span><span></span></div>
    <span id="thinking-text">Thinking...</span>
  `
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

function hideThinking() {
  const el = document.getElementById('thinking')
  if (el) el.remove()
}

/** Update the text shown in the thinking indicator (e.g. "Still thinking...") */
function updateThinkingMessage(text) {
  const el = document.getElementById('thinking-text')
  if (el) el.textContent = text
}

function setInputEnabled(enabled) {
  const input = document.getElementById('user-input')
  const sendBtn = document.getElementById('send-btn')
  input.disabled = !enabled
  sendBtn.disabled = !enabled || !input.value.trim()
  if (enabled) input.focus()
}

function updateSendButton() {
  const input = document.getElementById('user-input')
  document.getElementById('send-btn').disabled = !input.value.trim() || isWaitingForResponse
}

function updateStepActions() {
  const stepDef = V3_STEPS.find((s) => s.order === currentStep?.order)
  if (!stepDef || currentStep?.is_completed) {
    removeCompletionCta()
    return
  }

  // Detect if the AI has naturally concluded this step
  const aiConcluded = lastAssistantContent && hasAiConcluded(lastAssistantContent, roundCount)

  // Show CTA when:
  // 1. AI concluded (explicit language OR delivered a complete artifact with no questions), OR
  // 2. We've reached or passed maxRounds (AI was told to wrap up)
  const shouldShow = aiConcluded || roundCount >= stepDef.maxRounds

  if (shouldShow) {
    showCompletionCta(stepDef)
  } else {
    removeCompletionCta()
  }
}

/** Check if the TAIL of the message has questions directed at the user.
 *  Questions embedded in document body (checklists, FAQs) don't count —
 *  only questions near the END indicate the AI is waiting for input. */
function hasQuestionsForUser(text) {
  const tail = text.slice(-500)
  // Lines ending with ? in the tail
  if (/\?\s*$/m.test(tail)) return true
  // Lettered options (A. / A) choice prompts) in the tail
  if (/^[A-D][.)]\s/m.test(tail)) return true
  // Numbered questions in the tail: "1. What about X?"
  if (/^\d+\.\s.*\?/m.test(tail)) return true
  return false
}

/** Check if text looks like a completed artifact (final deliverable).
 *  Long, structured content with no trailing questions = the AI already
 *  wrote the document and we don't need to ask it again. */
function isCompletedArtifact(text) {
  if (!text || text.length < 1500) return false
  const hasStructure = /^#{1,3}\s/m.test(text) || /^\|.+\|$/m.test(text) || /^[-*]\s.+/m.test(text)
  if (!hasStructure) return false
  return !hasQuestionsForUser(text)
}

/** Check if the AI's message indicates step completion.
 *  Three signals:
 *  1. AI is OFFERING to write ("shall I draft...", "ready for me to...") — any round
 *  2. AI already DELIVERED the artifact ("here's the complete...", "I've compiled...") — any round
 *  3. Structural: long artifact with no trailing questions — requires rounds >= 2 */
function hasAiConcluded(text, rounds) {
  // Signal 1: AI offering to write the final document
  const offerPatterns = [
    /I think I have a solid picture/i,
    /I have enough information/i,
    /I have sufficient information/i,
    /ready for me to put together/i,
    /ready for me to (draft|write|create|compile)/i,
    /ready to finalize/i,
    /ready to compile/i,
    /ready to move on/i,
    /shall I (draft|write|create|compile|put together|finalize)/i,
    /I have a (clear|comprehensive|good|thorough) understanding/i,
    /enough detail to/i,
    /I feel confident/i,
    /that covers everything/i,
    /we('ve| have) covered (all|everything)/i,
  ]
  const matchedOffer = offerPatterns.find((p) => p.test(text))
  if (matchedOffer) {
    console.log('[PRDStack] hasAiConcluded: OFFER match:', matchedOffer.source, 'rounds:', rounds)
    return true
  }

  // Signal 2: AI already delivering the artifact (these phrases introduce a document)
  const deliveryPatterns = [
    /let me (now )?(draft|write|create|compile|put together|finalize|summarize)/i,
    /I('ll| will) (now )?(draft|write|create|compile|put together|finalize)/i,
    /here('s| is) (your|the) (complete|comprehensive|full|final)/i,
    /I've (compiled|put together|summarized|created|written|drafted)/i,
    /below is (your|the|a) (complete|comprehensive|full|final)/i,
    /here is (your|the) (complete|comprehensive|full|final)/i,
  ]
  const matchedDelivery = deliveryPatterns.find((p) => p.test(text))
  if (matchedDelivery) {
    console.log('[PRDStack] hasAiConcluded: DELIVERY match:', matchedDelivery.source, 'rounds:', rounds)
    return true
  }

  // Signal 3: Structural — text looks like a completed artifact.
  // GUARD: requires at least 2 completed rounds — the first message is always an intro.
  // Only checks the TAIL for questions — ? marks in the body (checklists, FAQs) are fine.
  if (rounds < 2) {
    console.log('[PRDStack] hasAiConcluded: too few rounds:', rounds)
    return false
  }

  if (isCompletedArtifact(text)) {
    console.log('[PRDStack] hasAiConcluded: STRUCTURAL match, rounds:', rounds, 'len:', text.length)
    return true
  }

  return false
}

function showCompletionCta(stepDef) {
  // Don't duplicate
  if (document.getElementById('completion-cta')) return

  const container = document.getElementById('messages')
  const cta = document.createElement('div')
  cta.id = 'completion-cta'
  cta.className = 'step-complete-cta'
  // Determine if the AI already delivered the final document
  const alreadyHasArtifact = isCompletedArtifact(lastAssistantContent)

  cta.innerHTML = `
    <div class="cta-text">
      <strong>Ready to finalize this step?</strong><br>
      ${alreadyHasArtifact
        ? `Save your ${escapeHtml(currentStep.title)} content and move to the next step.`
        : `The AI will write the final ${escapeHtml(currentStep.title)} document based on your conversation.`
      }
    </div>
    <button class="cta-button" id="cta-complete-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        ${alreadyHasArtifact
          ? '<polyline points="20 6 9 17 4 12"/>'
          : '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'
        }
      </svg>
      ${alreadyHasArtifact
        ? `Complete ${escapeHtml(currentStep.title)}`
        : `Write ${escapeHtml(currentStep.title)} Document`
      }
    </button>
    <div class="round-info">${roundCount >= stepDef.maxRounds ? 'The AI has gathered enough information.' : `Round ${roundCount} of ~${stepDef.maxRounds}`} You can keep chatting or finalize now.</div>
  `
  container.appendChild(cta)
  container.scrollTop = container.scrollHeight

  document.getElementById('cta-complete-btn').addEventListener('click', () => {
    if (isCompletedArtifact(lastAssistantContent)) {
      // AI already wrote the document — just save and advance
      console.log('[PRDStack] CTA: artifact already exists, completing directly')
      completeStep()
    } else {
      // AI hasn't written the document yet — ask it to, then auto-complete
      console.log('[PRDStack] CTA: no artifact yet, requesting finalization')
      requestFinalization()
    }
  })
}

function removeCompletionCta() {
  const el = document.getElementById('completion-cta')
  if (el) el.remove()
}

function updateRoundCounter() {
  const stepDef = V3_STEPS.find((s) => s.order === currentStep?.order)
  if (stepDef) {
    document.getElementById('round-counter').textContent =
      `Round ${roundCount}/${stepDef.maxRounds}`
  }
}

function getConvergenceInstruction(currentRound, maxRounds) {
  const midpoint = Math.ceil(maxRounds / 2)
  if (currentRound <= midpoint) {
    return 'You are in the exploration phase. Ask thoughtful questions to deeply understand the project. Focus on uncovering requirements, constraints, and goals.'
  } else if (currentRound < maxRounds) {
    return 'You are approaching the conclusion of this step. Start synthesizing what you have learned. Confirm key decisions with the user.'
  } else {
    return 'This is the final round. You should now have enough information. Say EXACTLY: "I think I have a solid picture now of what we need for this step. Ready for me to put together the final document?" Then produce your final artifact.'
  }
}

function extractFirstResponse(promptContent) {
  // Extract content between <first_response> and </first_response> tags
  // The prompt files use escaped markdown: \<first\_response\>
  const patterns = [
    /<first_response>\s*([\s\S]*?)\s*<\/first_response>/i,
    /\\<first_response\\>\s*([\s\S]*?)\s*\\<\/first_response\\>/i,
    /\\<first\\_response\\>\s*([\s\S]*?)\s*\\<\/first\\_response\\>/i,
    /\\<first\\_response>\s*([\s\S]*?)\s*\\<\/first\\_response>/i,
  ]
  for (const pattern of patterns) {
    const match = promptContent.match(pattern)
    if (match) {
      // Clean up ALL escaped markdown characters in one pass:
      // \# → #, \* → *, \- → -, \_ → _, \[ → [, \] → ], \. → ., \< → <, \> → >, \! → !
      return match[1]
        // eslint-disable-next-line no-useless-escape
        .replace(/\\([#*\-_\[\].><!\\])/g, '$1')
        .trim()
    }
  }
  return null
}


function formatStatus(status) {
  switch (status) {
    case 'draft': return 'Draft'
    case 'in_progress': return 'In Progress'
    case 'completed': return 'Completed'
    default: return status
  }
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function renderMarkdown(text) {
  if (!text) return ''
  try {
    // Use marked library for full GFM markdown rendering
    return marked.parse(text, { gfm: true, breaks: true })
  } catch {
    // Fallback to escaped plain text if marked fails
    return `<p>${escapeHtml(text)}</p>`
  }
}

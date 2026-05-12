// PRDStack Autopilot Engine
// Automated PRD generation — intake, step execution, decision cards, decomposer, completion
// Shares webview context with plugin.js: V3_STEPS, escapeHtml, showView, buildSystemPrompt,
// getConvergenceInstruction, parsePlannedFileNames, generateKickoffPrompt, fileNameToDisplayName,
// loadDashboard, pushSidebarItems, showConfirm, sendAndWaitForResponse, waitForSessionResponse

const autopilotAmc = window.AgentMC

// -- Autopilot State ---------------------------------------------------------
let apState = 'idle' // idle | intake | running | paused | completing | done | aborted
let apPrd = null
let apSteps = []
let apCurrentStepIndex = 0
let apSessionId = null
let apRoundCount = 0
let apMaxRounds = 0
let apDecisionLog = []
let apPollTimer = null
let apElapsedTimer = null
let apElapsedSeconds = 0
let apCountdownTimer = null
let apCountdownRemaining = 0
let apProcessingMessage = false
let apLastAssistantCount = 0
let apIntakeSummary = ''
let apProjectName = ''
let apFollowUpCount = 0
let apExportFolder = ''
let apParentFolder = ''
let apCompletedFiles = []

const AP_COUNTDOWN_SECONDS = 5
const AP_POLL_INTERVAL = 800
const AP_CONTINUE_DELAY = 15000 // 15s before auto-continue if no options found

// -- State Persistence -------------------------------------------------------

async function persistAutopilotState() {
  if (!apPrd) return
  try {
    const existing = await autopilotAmc.db.getById('prds', apPrd.id)
    const ctx = (existing && typeof existing.project_context === 'object' && existing.project_context) || {}
    ctx.autopilot = {
      state: apState,
      currentStepIndex: apCurrentStepIndex,
      roundCount: apRoundCount,
      decisionLog: apDecisionLog,
      intakeSummary: apIntakeSummary,
      projectName: apProjectName,
      parentFolder: apParentFolder,
      exportFolder: apExportFolder,
      elapsedSeconds: apElapsedSeconds,
      sessionId: apSessionId,
      lastUpdated: new Date().toISOString(),
    }
    await autopilotAmc.db.update('prds', apPrd.id, { project_context: ctx })
  } catch (err) {
    console.warn('[Autopilot] Failed to persist state:', err)
  }
}

async function persistDecomposerPlan(plannedFiles) {
  if (!apPrd) return
  try {
    const existing = await autopilotAmc.db.getById('prds', apPrd.id)
    const ctx = (existing && typeof existing.project_context === 'object' && existing.project_context) || {}
    if (!ctx.autopilot) ctx.autopilot = {}
    ctx.autopilot.decomposer = {
      plannedFiles,
      completedFiles: [],
    }
    await autopilotAmc.db.update('prds', apPrd.id, { project_context: ctx })
    apPrd.project_context = ctx
  } catch (err) {
    console.warn('[Autopilot] Failed to persist decomposer plan:', err)
  }
}

async function persistDecomposerProgress(plannedFiles, justCompleted) {
  if (!apPrd) return
  try {
    const existing = await autopilotAmc.db.getById('prds', apPrd.id)
    const ctx = (existing && typeof existing.project_context === 'object' && existing.project_context) || {}
    if (!ctx.autopilot) ctx.autopilot = {}
    const decomp = ctx.autopilot.decomposer || { plannedFiles, completedFiles: [] }
    if (!decomp.completedFiles.includes(justCompleted)) {
      decomp.completedFiles.push(justCompleted)
    }
    ctx.autopilot.decomposer = decomp
    await autopilotAmc.db.update('prds', apPrd.id, { project_context: ctx })
    apPrd.project_context = ctx
  } catch (err) {
    console.warn('[Autopilot] Failed to persist decomposer progress:', err)
  }
}

// Called from plugin.js when opening a PRD that has autopilot state
async function restoreAutopilot(prd) {
  const ctx = prd.project_context
  if (!ctx || !ctx.autopilot) return false

  const saved = ctx.autopilot
  // Only restore if the run was active (not done/aborted/idle)
  if (!saved.state || saved.state === 'done' || saved.state === 'aborted' || saved.state === 'idle') return false

  // Restore state variables
  apPrd = prd
  apState = 'paused' // Always restore as paused — user can resume
  apCurrentStepIndex = saved.currentStepIndex || 0
  apRoundCount = saved.roundCount || 0
  apDecisionLog = saved.decisionLog || []
  apIntakeSummary = saved.intakeSummary || ''
  apProjectName = saved.projectName || ''
  apParentFolder = saved.parentFolder || ''
  apExportFolder = saved.exportFolder || ''
  apElapsedSeconds = saved.elapsedSeconds || 0
  apSessionId = null // Session is likely dead after navigation/restart
  apCompletedFiles = []
  apLastAssistantCount = 0
  apProcessingMessage = false

  // Load step records
  apSteps = await autopilotAmc.db.query('steps', {
    where: { prd_id: apPrd.id },
    orderBy: { order: 'asc' },
  })

  // Figure out which step to resume from — first incomplete step
  const firstIncompleteIdx = apSteps.findIndex((s) => !s.is_completed)
  if (firstIncompleteIdx >= 0) {
    apCurrentStepIndex = firstIncompleteIdx
  } else {
    // All steps done — the decomposer might not have finished cleanly
    apCurrentStepIndex = V3_STEPS.length - 1
  }

  apMaxRounds = V3_STEPS[apCurrentStepIndex]?.maxRounds || 8

  // Show autopilot view
  showView('autopilot-view')
  renderStepRail()
  startElapsedTimer()
  wireAutopilotControls()

  // Render decision feed from saved log
  renderRestoredDecisionFeed()

  // Show resume banner
  showResumeBanner()

  return true
}

function renderRestoredDecisionFeed() {
  const feed = document.getElementById('autopilot-decision-feed')
  feed.innerHTML = ''

  if (apDecisionLog.length === 0) {
    feed.innerHTML = '<div class="decision-feed-empty">Autopilot was interrupted. Click Resume to continue.</div>'
    return
  }

  // Group decisions by step
  const stepGroups = new Map()
  for (const d of apDecisionLog) {
    if (!stepGroups.has(d.stepIndex)) stepGroups.set(d.stepIndex, [])
    stepGroups.get(d.stepIndex).push(d)
  }

  for (const [stepIndex, decisions] of stepGroups) {
    const stepDef = V3_STEPS[stepIndex]
    if (!stepDef) continue

    // Create step group
    const group = document.createElement('div')
    group.className = 'step-group'
    group.dataset.stepIndex = stepIndex

    group.innerHTML = `
      <div class="step-group-header">
        <span class="step-group-icon">&#9654;</span>
        <span>Step ${stepDef.order}: ${escapeHtml(stepDef.title)}</span>
        <span class="step-group-count">${decisions.length} decision${decisions.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="step-group-body"></div>
    `

    const body = group.querySelector('.step-group-body')

    for (const d of decisions) {
      const card = document.createElement('div')
      card.className = 'decision-card collapsed'

      const badge = d.auto ? 'Auto: Option ' + d.selected : 'Selected: Option ' + d.selected
      const questionSummary = (d.question || '').slice(0, 80)
      const ellipsis = (d.question || '').length > 80 ? '...' : ''

      card.innerHTML = `
        <div class="decision-card-header">
          <span class="decision-card-step" data-summarized="true">${escapeHtml(stepDef.title)} &middot; Round ${d.round} &mdash; ${escapeHtml(questionSummary)}${ellipsis}</span>
          <span class="expand-chevron">&#9660;</span>
          <span class="decision-card-result${d.auto ? '' : ' overridden'}">${badge}</span>
        </div>
        <div class="decision-card-question">${escapeHtml(d.question || '')}</div>
        <div class="decision-card-options">
          ${d.options.map((opt, i) =>
            `<div class="decision-option${i + 1 === d.selected ? ' selected' : ''}">${escapeHtml(opt)}</div>`
          ).join('')}
        </div>
      `

      // Wire click-to-expand
      card.addEventListener('click', () => {
        card.classList.toggle('expanded')
      })

      body.appendChild(card)
    }

    feed.appendChild(group)
  }

  feed.scrollTop = feed.scrollHeight
}

function showResumeBanner() {
  const completedCount = apSteps.filter((s) => s.is_completed).length
  const stepDef = V3_STEPS[apCurrentStepIndex]
  const stepName = stepDef ? stepDef.title : `Step ${apCurrentStepIndex + 1}`

  updateStatusStrip(`Paused at ${stepName}`, completedCount, V3_STEPS.length)

  // Set pause button to show Resume
  const pauseBtn = document.getElementById('ap-pause-btn')
  if (pauseBtn) pauseBtn.textContent = 'Resume'

  addProgressCard(`Autopilot was interrupted. ${completedCount}/${V3_STEPS.length} steps completed. Click Resume to continue from ${stepName}.`)
}

async function resumeFromInterruption() {
  apState = 'running'
  await persistAutopilotState()

  // Start a fresh session for the current step
  await runAutopilotStep(apCurrentStepIndex)
}

// -- Intake Flow -------------------------------------------------------------

function startAutopilotIntake() {
  apState = 'intake'
  apFollowUpCount = 0

  showView('intake-view')

  const textarea = document.getElementById('intake-textarea')
  const submitBtn = document.getElementById('intake-submit-btn')
  const launchBtn = document.getElementById('intake-launch-btn')
  const backBtn = document.getElementById('intake-back-btn')
  const followupSection = document.getElementById('intake-followup')
  const projectNameSection = document.getElementById('intake-project-name-section')
  const statusEl = document.getElementById('intake-status')

  // Reset state
  textarea.value = ''
  textarea.disabled = false
  submitBtn.disabled = true
  submitBtn.classList.remove('hidden')
  launchBtn.classList.add('hidden')
  followupSection.classList.add('hidden')
  projectNameSection.classList.add('hidden')
  statusEl.classList.add('hidden')

  // Wire submit — clone first so the input handler references the live node
  submitBtn.replaceWith(submitBtn.cloneNode(true))
  const freshSubmit = document.getElementById('intake-submit-btn')
  freshSubmit.disabled = true
  freshSubmit.addEventListener('click', () => validateIntake())

  // Wire textarea enable (must reference freshSubmit, not the detached original)
  textarea.addEventListener('input', () => {
    freshSubmit.disabled = !textarea.value.trim()
  })

  // Wire back
  backBtn.replaceWith(backBtn.cloneNode(true))
  const freshBack = document.getElementById('intake-back-btn')
  freshBack.addEventListener('click', () => {
    apState = 'idle'
    showView('dashboard-view')
    loadDashboard()
  })
}

async function validateIntake() {
  const textarea = document.getElementById('intake-textarea')
  const followupInput = document.getElementById('intake-followup-input')
  const statusEl = document.getElementById('intake-status')
  const submitBtn = document.getElementById('intake-submit-btn')

  // Combine original description + any follow-up answers
  let description = textarea.value.trim()
  if (followupInput && !document.getElementById('intake-followup').classList.contains('hidden')) {
    const answer = followupInput.value.trim()
    if (answer) description += '\n\nAdditional detail: ' + answer
  }

  // Show loading state
  submitBtn.disabled = true
  statusEl.textContent = 'Analyzing your idea...'
  statusEl.classList.remove('hidden')

  try {
    const intakePrompt = await autopilotAmc.assets.readFile('prompts/v3/intake_validation.md')
    const fullPrompt = intakePrompt + '\n\n---\n\nUser description:\n' + description

    const result = await autopilotAmc.session.create({ prompt: fullPrompt })
    const response = await waitForSessionResponse(result.sessionId, 60000)

    // Stop the validation session
    autopilotAmc.session.stop(result.sessionId).catch(() => {})

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const parsed = JSON.parse(jsonMatch[0])

    if (parsed.sufficient) {
      // Success — show project name + launch button
      apIntakeSummary = description
      apProjectName = parsed.projectName || 'NewProject'
      apParentFolder = ''

      const projectNameSection = document.getElementById('intake-project-name-section')
      const nameInput = document.getElementById('intake-project-name')
      nameInput.value = apProjectName
      projectNameSection.classList.remove('hidden')

      // Wire folder picker
      const folderInput = document.getElementById('intake-folder-path')
      const browseBtn = document.getElementById('intake-browse-btn')
      const folderHint = document.getElementById('intake-folder-hint')
      folderInput.value = ''
      folderHint.textContent = ''

      browseBtn.replaceWith(browseBtn.cloneNode(true))
      const freshBrowse = document.getElementById('intake-browse-btn')
      freshBrowse.addEventListener('click', async () => {
        try {
          const result = await autopilotAmc.export.pickFolder({
            title: 'Choose parent folder for your project'
          })
          if (result && result.path) {
            apParentFolder = result.path
            folderInput.value = result.path
            const name = document.getElementById('intake-project-name').value || apProjectName
            folderHint.textContent = `Project will be created at: ${result.path}/${sanitizeProjectName(name)}`
          }
        } catch (err) {
          console.warn('[Autopilot] Folder picker error:', err)
        }
      })

      // Also allow clicking the input to trigger browse
      folderInput.replaceWith(folderInput.cloneNode(true))
      const freshFolderInput = document.getElementById('intake-folder-path')
      freshFolderInput.addEventListener('click', () => {
        document.getElementById('intake-browse-btn').click()
      })

      submitBtn.classList.add('hidden')
      const launchBtn = document.getElementById('intake-launch-btn')
      launchBtn.classList.remove('hidden')

      statusEl.textContent = parsed.summary || 'Ready to launch'

      // Wire launch button
      launchBtn.replaceWith(launchBtn.cloneNode(true))
      const freshLaunch = document.getElementById('intake-launch-btn')
      freshLaunch.addEventListener('click', () => {
        apProjectName = sanitizeProjectName(document.getElementById('intake-project-name').value)
        if (!apParentFolder) {
          folderHint.textContent = 'Please select a folder location first'
          folderHint.style.color = 'var(--prd-error, #ef4444)'
          return
        }
        folderHint.style.color = ''
        startAutopilotRun()
      })
    } else {
      // Need more info — show follow-up
      apFollowUpCount++

      if (apFollowUpCount >= 3) {
        // Max follow-ups reached — just proceed with what we have
        apIntakeSummary = description
        apProjectName = 'NewProject'
        apParentFolder = ''
        statusEl.textContent = 'Proceeding with available information...'
        submitBtn.classList.add('hidden')

        const projectNameSection = document.getElementById('intake-project-name-section')
        const nameInput = document.getElementById('intake-project-name')
        nameInput.value = apProjectName
        projectNameSection.classList.remove('hidden')

        // Wire folder picker (same as success path)
        const folderInput = document.getElementById('intake-folder-path')
        const browseBtn = document.getElementById('intake-browse-btn')
        const folderHint = document.getElementById('intake-folder-hint')
        folderInput.value = ''
        folderHint.textContent = ''

        browseBtn.replaceWith(browseBtn.cloneNode(true))
        document.getElementById('intake-browse-btn').addEventListener('click', async () => {
          try {
            const result = await autopilotAmc.export.pickFolder({
              title: 'Choose parent folder for your project'
            })
            if (result && result.path) {
              apParentFolder = result.path
              document.getElementById('intake-folder-path').value = result.path
              const name = document.getElementById('intake-project-name').value || apProjectName
              document.getElementById('intake-folder-hint').textContent =
                `Project will be created at: ${result.path}/${sanitizeProjectName(name)}`
            }
          } catch (err) {
            console.warn('[Autopilot] Folder picker error:', err)
          }
        })

        folderInput.replaceWith(folderInput.cloneNode(true))
        document.getElementById('intake-folder-path').addEventListener('click', () => {
          document.getElementById('intake-browse-btn').click()
        })

        const launchBtn = document.getElementById('intake-launch-btn')
        launchBtn.classList.remove('hidden')
        launchBtn.replaceWith(launchBtn.cloneNode(true))
        document.getElementById('intake-launch-btn').addEventListener('click', () => {
          apProjectName = sanitizeProjectName(document.getElementById('intake-project-name').value)
          if (!apParentFolder) {
            document.getElementById('intake-folder-hint').textContent = 'Please select a folder location first'
            document.getElementById('intake-folder-hint').style.color = 'var(--prd-error, #ef4444)'
            return
          }
          document.getElementById('intake-folder-hint').style.color = ''
          startAutopilotRun()
        })
        return
      }

      const followupSection = document.getElementById('intake-followup')
      const followupQuestion = document.getElementById('intake-followup-question')
      const followupInput = document.getElementById('intake-followup-input')

      followupQuestion.textContent = parsed.followUp || 'Can you tell me more about your idea?'
      followupInput.value = ''
      followupSection.classList.remove('hidden')

      submitBtn.disabled = false
      submitBtn.textContent = 'Re-analyze'
      statusEl.textContent = `Follow-up ${apFollowUpCount}/3`
    }
  } catch (err) {
    console.error('[Autopilot] Intake validation failed:', err)
    statusEl.textContent = 'Analysis failed — try again'
    submitBtn.disabled = false
  }
}

function sanitizeProjectName(name) {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    || 'NewProject'
}

// -- Autopilot Run -----------------------------------------------------------

async function startAutopilotRun() {
  apState = 'running'
  apDecisionLog = []
  apRoundCount = 0
  apCurrentStepIndex = 0
  apElapsedSeconds = 0
  apCompletedFiles = []
  apExportFolder = ''

  try {
    // Create PRD record
    apPrd = await autopilotAmc.db.insert('prds', {
      title: apProjectName,
      status: 'in_progress',
      progress: 0,
      flow_version: 'v3',
      current_step: 1,
      project_context: { autopilot: true, intakeDescription: apIntakeSummary },
    })

    // Create 13 step records
    for (const step of V3_STEPS) {
      await autopilotAmc.db.insert('steps', {
        prd_id: apPrd.id,
        order: step.order,
        title: step.title,
        phase: step.phase,
        is_completed: 0,
        generated_content: '',
        context_summary: '',
      })
    }

    // Load step records
    apSteps = await autopilotAmc.db.query('steps', {
      where: { prd_id: apPrd.id },
      orderBy: { order: 'asc' },
    })

    pushSidebarItems()

    // Switch to autopilot view
    showView('autopilot-view')
    renderStepRail()
    startElapsedTimer()
    wireAutopilotControls()

    // Persist initial state
    await persistAutopilotState()

    // Begin step 1
    await runAutopilotStep(0)
  } catch (err) {
    console.error('[Autopilot] Failed to start run:', err)
    autopilotAmc.toast.show({ type: 'error', message: 'Failed to start autopilot: ' + (err.message || err) })
    apState = 'idle'
    showView('dashboard-view')
    loadDashboard()
  }
}

// -- Step Rail ---------------------------------------------------------------

function renderStepRail() {
  const rail = document.getElementById('autopilot-step-rail')
  rail.innerHTML = ''

  let currentPhase = ''
  for (let i = 0; i < V3_STEPS.length; i++) {
    const stepDef = V3_STEPS[i]

    if (stepDef.phase !== currentPhase) {
      currentPhase = stepDef.phase
      const header = document.createElement('div')
      header.className = 'ap-rail-phase'
      header.textContent = currentPhase
      rail.appendChild(header)
    }

    const state = i < apCurrentStepIndex ? 'completed'
      : i === apCurrentStepIndex ? 'active'
      : 'upcoming'

    const item = document.createElement('div')
    item.className = `ap-rail-step ${state}`
    item.id = `ap-rail-step-${i}`
    item.innerHTML = `<div class="ap-rail-dot"></div><span>${stepDef.title}</span>`
    rail.appendChild(item)
  }
}

function updateStepRailState() {
  for (let i = 0; i < V3_STEPS.length; i++) {
    const item = document.getElementById(`ap-rail-step-${i}`)
    if (!item) continue

    const state = i < apCurrentStepIndex ? 'completed'
      : i === apCurrentStepIndex ? 'active'
      : 'upcoming'

    item.className = `ap-rail-step ${state}`
  }
}

// -- Status Strip ------------------------------------------------------------

function updateStatusStrip(stepName, round, maxRounds) {
  const nameEl = document.getElementById('ap-step-name')
  const roundEl = document.getElementById('ap-round')
  if (nameEl) nameEl.textContent = stepName
  if (roundEl) roundEl.textContent = `Round ${round}/${maxRounds}`
}

function startElapsedTimer() {
  if (apElapsedTimer) clearInterval(apElapsedTimer)
  apElapsedTimer = setInterval(() => {
    if (apState === 'paused') return
    apElapsedSeconds++
    const el = document.getElementById('ap-elapsed')
    if (el) el.textContent = formatElapsed(apElapsedSeconds)
  }, 1000)
}

function stopElapsedTimer() {
  if (apElapsedTimer) {
    clearInterval(apElapsedTimer)
    apElapsedTimer = null
  }
}

function formatElapsed(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

// -- Pause / Resume / Abort --------------------------------------------------

function wireAutopilotControls() {
  const pauseBtn = document.getElementById('ap-pause-btn')
  const abortBtn = document.getElementById('ap-abort-btn')

  // Replace to clear old listeners
  pauseBtn.replaceWith(pauseBtn.cloneNode(true))
  abortBtn.replaceWith(abortBtn.cloneNode(true))

  document.getElementById('ap-pause-btn').addEventListener('click', togglePause)
  document.getElementById('ap-abort-btn').addEventListener('click', abortAutopilot)
}

function togglePause() {
  const pauseBtn = document.getElementById('ap-pause-btn')

  if (apState === 'running') {
    apState = 'paused'
    pauseBtn.textContent = 'Resume'
    persistAutopilotState().catch(() => {})
    // Freeze countdown if active
    if (apCountdownTimer) {
      clearInterval(apCountdownTimer)
      apCountdownTimer = null
    }
  } else if (apState === 'paused') {
    // Check if this is a resume from interruption (no active session)
    if (!apSessionId) {
      resumeFromInterruption()
      pauseBtn.textContent = 'Pause'
      return
    }
    apState = 'running'
    pauseBtn.textContent = 'Pause'
    persistAutopilotState().catch(() => {})
    // Restart countdown from full if there's an active decision card
    const activeCard = document.querySelector('.decision-card.active')
    if (activeCard) {
      const countdownFill = activeCard.querySelector('.decision-countdown-fill')
      if (countdownFill) {
        apCountdownRemaining = AP_COUNTDOWN_SECONDS
        startCountdownBar(countdownFill, () => {
          autoSelectOption(activeCard)
        })
      }
    }
  }
}

async function abortAutopilot() {
  const confirmed = await showConfirm(
    'Abort Autopilot',
    'This will stop the autopilot run and delete all progress for this PRD. Are you sure?'
  )
  if (!confirmed) return

  apState = 'aborted'

  // Clean up
  stopAutopilotPolling()
  stopElapsedTimer()
  clearCountdown()

  if (apSessionId) {
    autopilotAmc.session.stop(apSessionId).catch(() => {})
    apSessionId = null
  }

  // Delete PRD + steps + messages
  if (apPrd) {
    try {
      await autopilotAmc.db.deleteWhere('prd_files', { prd_id: apPrd.id })
      await autopilotAmc.db.deleteWhere('messages', { prd_id: apPrd.id })
      await autopilotAmc.db.deleteWhere('steps', { prd_id: apPrd.id })
      await autopilotAmc.db.delete('prds', apPrd.id)
    } catch (err) {
      console.warn('[Autopilot] Cleanup failed:', err)
    }
  }

  apPrd = null
  apSteps = []
  apState = 'idle'
  // State is cleared — PRD was deleted so no need to persist
  autopilotAmc.toast.show({ type: 'info', message: 'Autopilot aborted' })
  showView('dashboard-view')
  loadDashboard()
  pushSidebarItems()
}

// -- Step Execution ----------------------------------------------------------

async function runAutopilotStep(stepIndex) {
  if (apState === 'aborted' || apState === 'done') return

  apCurrentStepIndex = stepIndex
  apRoundCount = 0
  apLastAssistantCount = 0
  apProcessingMessage = false

  const stepDef = V3_STEPS[stepIndex]
  const step = apSteps[stepIndex]
  apMaxRounds = stepDef.maxRounds

  updateStepRailState()
  updateStatusStrip(stepDef.title, 0, stepDef.maxRounds)

  // Decomposer (step 13) has a special flow
  if (stepDef.order === V3_STEPS.length) {
    await runAutopilotDecomposer(step, stepDef)
    return
  }

  try {
    // Build system prompt with autopilot addendum
    const systemPrompt = await buildAutopilotSystemPrompt(step, stepDef)

    // Determine the user's first message for this step
    let userMessage
    if (stepIndex === 0) {
      // Step 1: user's intake description is the first message
      userMessage = apIntakeSummary
    } else {
      userMessage = 'Begin this step. Present your first set of decisions with numbered options.'
    }

    const fullPrompt = systemPrompt + '\n\n---\n\n' + userMessage

    // Spawn session
    const result = await autopilotAmc.session.create({ prompt: fullPrompt })
    apSessionId = result.sessionId

    // Rename session for identification
    autopilotAmc.session.rename(apSessionId, `Autopilot: ${apPrd.title} - ${stepDef.title}`).catch(() => {})

    // Add a feed card for step transition
    if (stepIndex > 0) {
      addStepTransitionCard(stepDef)
    }

    // Start polling
    startAutopilotPolling()
  } catch (err) {
    console.error('[Autopilot] Failed to start step:', err)
    handleAutopilotError('Failed to start step: ' + (err.message || err))
  }
}

async function buildAutopilotSystemPrompt(step, stepDef) {
  const masterPrompt = await autopilotAmc.assets.readFile('prompts/v3/master_system_prompt.md')
  const stepPrompt = await autopilotAmc.assets.readFile(`prompts/v3/${stepDef.file}`)
  const addendum = await autopilotAmc.assets.readFile('prompts/v3/autopilot_addendum.md')

  // Build project context from completed steps
  const completedSteps = await autopilotAmc.db.query('steps', {
    where: { prd_id: apPrd.id, is_completed: 1 },
    orderBy: { order: 'asc' },
  })

  let contextBlock = ''

  // Always inject intake description as Step 0 context
  contextBlock += `Step 0 -- User's Vision:\n${apIntakeSummary}\n\n`

  // Add completed step summaries
  const stepContext = completedSteps
    .filter((s) => s.context_summary)
    .map((s) => `Step ${s.order} -- ${s.title}:\n${s.context_summary}`)
    .join('\n\n')
  if (stepContext) contextBlock += stepContext

  const convergenceInstruction = getConvergenceInstruction(apRoundCount + 1, stepDef.maxRounds)

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
    .replace('{{currentRound}}', String(apRoundCount + 1))
    .replace('{{maxRounds}}', String(stepDef.maxRounds))
    .replace('{{convergenceInstruction}}', convergenceInstruction)

  fullPrompt += '\n\n---\n\n' + stepPrompt
  fullPrompt += '\n\n---\n\n' + addendum

  return fullPrompt
}

// -- Autopilot Polling -------------------------------------------------------

function startAutopilotPolling() {
  if (apPollTimer) return

  apPollTimer = setInterval(async () => {
    if (!apSessionId || apState === 'paused' || apProcessingMessage) return

    try {
      const statusResult = await autopilotAmc.session.getStatus(apSessionId)
      const status = statusResult.status
      const cliMessages = await autopilotAmc.session.getMessages(apSessionId)
      const assistantMessages = cliMessages.filter((m) => m.role === 'assistant')

      if (assistantMessages.length > apLastAssistantCount) {
        apProcessingMessage = true

        // Process each new assistant message
        for (let i = apLastAssistantCount; i < assistantMessages.length; i++) {
          const msg = assistantMessages[i]
          apRoundCount++

          // Save to DB
          const step = apSteps[apCurrentStepIndex]
          await autopilotAmc.db.insert('messages', {
            step_id: step.id,
            prd_id: apPrd.id,
            role: 'assistant',
            content: msg.content,
          })

          updateStatusStrip(V3_STEPS[apCurrentStepIndex].title, apRoundCount, apMaxRounds)

          // Parse for numbered options
          const options = parseOptions(msg.content)

          if (options.length > 0) {
            // Show decision card with countdown
            await showDecisionCard(msg.content, options)
          } else {
            // Show as progress update
            addProgressCard(msg.content)

            // If rounds exhausted, auto-complete
            if (apRoundCount >= apMaxRounds) {
              stopAutopilotPolling()
              await autoCompleteStep()
              apProcessingMessage = false
              return
            }

            // Auto-continue after delay
            await waitAndContinue()
          }
        }

        apLastAssistantCount = assistantMessages.length
        apProcessingMessage = false

        // Check if rounds exhausted after processing
        if (apRoundCount >= apMaxRounds) {
          stopAutopilotPolling()
          await autoCompleteStep()
          return
        }
      }

      // Stop on terminal states
      if (status === 'error') {
        stopAutopilotPolling()
        handleAutopilotError('AI session encountered an error')
      } else if (status === 'ended' && assistantMessages.length <= apLastAssistantCount) {
        stopAutopilotPolling()
        // Session ended without new messages — auto-complete what we have
        if (apRoundCount > 0) {
          await autoCompleteStep()
        } else {
          handleAutopilotError('AI session ended without responding')
        }
      }
    } catch (err) {
      console.error('[Autopilot] Poll error:', err)
    }
  }, AP_POLL_INTERVAL)
}

function stopAutopilotPolling() {
  if (apPollTimer) {
    clearInterval(apPollTimer)
    apPollTimer = null
  }
}

// -- Option Parsing ----------------------------------------------------------

function parseOptions(text) {
  const options = []
  // Match patterns like:
  // 1. **Option text** -- description
  // 1) Option text
  // 1. Option text
  const pattern = /^(\d+)[.)]\s+(.+)$/gm
  let match

  while ((match = pattern.exec(text)) !== null) {
    const num = parseInt(match[1], 10)
    let raw = match[2].replace(/\*+/g, '').trim()
    // Split on " -- " or " — " separator if present
    let title = raw
    let desc = ''
    const sepMatch = raw.match(/^(.+?)\s+(?:--|—)\s+(.+)$/)
    if (sepMatch) {
      title = sepMatch[1].trim()
      desc = sepMatch[2].trim()
    }
    options.push({ num, title, desc, text: desc ? `${title} -- ${desc}` : title })
  }

  // Only return if we found at least 2 sequential options starting from 1
  if (options.length >= 2 && options[0].num === 1) {
    return options
  }
  return []
}

function extractQuestionText(content) {
  // Get the text before the numbered options — that's the question/context
  const lines = content.split('\n')
  const questionLines = []
  for (const line of lines) {
    if (/^\d+[.)]\s/.test(line.trim())) break
    questionLines.push(line)
  }
  return questionLines.join('\n').trim()
}

// -- Decision Cards ----------------------------------------------------------

function collapseDecisionCard(card) {
  card.classList.remove('active')
  card.classList.add('collapsed')

  // Add question summary to header for collapsed view
  const questionEl = card.querySelector('.decision-card-question')
  const headerStepEl = card.querySelector('.decision-card-step')
  if (questionEl && headerStepEl && !headerStepEl.dataset.summarized) {
    const summary = questionEl.textContent.trim().slice(0, 80)
    headerStepEl.textContent += ' \u2014 ' + summary + (questionEl.textContent.trim().length > 80 ? '...' : '')
    headerStepEl.dataset.summarized = 'true'
  }

  // Wire click-to-expand/collapse
  card.addEventListener('click', () => {
    card.classList.toggle('expanded')
  })
}

function showDecisionCard(content, options) {
  return new Promise((resolve) => {
    if (apState === 'aborted' || apState === 'done') {
      resolve()
      return
    }

    const feed = document.getElementById('autopilot-decision-feed')
    const emptyEl = feed.querySelector('.decision-feed-empty')
    if (emptyEl) emptyEl.remove()

    // Collapse previous active card and wire expand/collapse
    const prevActive = feed.querySelector('.decision-card.active')
    if (prevActive) {
      collapseDecisionCard(prevActive)
    }

    const stepDef = V3_STEPS[apCurrentStepIndex]
    const questionText = extractQuestionText(content)
    const card = document.createElement('div')
    card.className = 'decision-card active'

    let optionsHtml = ''
    for (const opt of options) {
      const highlighted = opt.num === 1 ? ' highlighted' : ''
      optionsHtml += `
        <div class="decision-option${highlighted}" data-option-num="${opt.num}">
          <span class="decision-option-number">${opt.num}.</span>
          <span>${escapeHtml(opt.text)}</span>
        </div>
      `
    }

    card.innerHTML = `
      <div class="decision-card-header">
        <span class="decision-card-step">${escapeHtml(stepDef.title)} &middot; Round ${apRoundCount}</span>
        <span class="expand-chevron">&#9660;</span>
        <span class="decision-card-result" id="card-result-${apRoundCount}"></span>
      </div>
      <div class="decision-card-question">${escapeHtml(questionText)}</div>
      <div class="decision-card-options">${optionsHtml}</div>
      <div class="decision-countdown"><div class="decision-countdown-fill"></div></div>
    `

    const body = getCurrentStepGroupBody()
    body.appendChild(card)
    updateStepGroupCount(apCurrentStepIndex)
    feed.scrollTop = feed.scrollHeight

    let resolved = false
    const cardRound = apRoundCount

    const selectOption = (optNum, isAuto) => {
      if (resolved) return
      resolved = true
      clearCountdown()

      // Mark selected option
      card.querySelectorAll('.decision-option').forEach((el) => {
        el.classList.remove('highlighted')
        if (parseInt(el.dataset.optionNum, 10) === optNum) {
          el.classList.add('selected')
        }
      })

      // Show result badge
      const resultEl = document.getElementById(`card-result-${cardRound}`)
      if (resultEl) {
        resultEl.textContent = isAuto ? `Auto: Option ${optNum}` : `Selected: Option ${optNum}`
        if (!isAuto) resultEl.classList.add('overridden')
      }

      // Log decision
      apDecisionLog.push({
        stepIndex: apCurrentStepIndex,
        stepTitle: stepDef.title,
        round: cardRound,
        question: questionText,
        options: options.map((o) => o.text),
        selected: optNum,
        auto: isAuto,
      })

      // Persist state with updated decision log
      persistAutopilotState().catch(() => {})

      // Send selection to session
      sendOptionSelection(optNum).then(resolve).catch(resolve)
    }

    // Wire option clicks
    card.querySelectorAll('.decision-option').forEach((el) => {
      el.addEventListener('click', () => {
        const num = parseInt(el.dataset.optionNum, 10)
        selectOption(num, false)
      })
    })

    // Start countdown
    if (apState === 'running') {
      const countdownFill = card.querySelector('.decision-countdown-fill')
      apCountdownRemaining = AP_COUNTDOWN_SECONDS
      startCountdownBar(countdownFill, () => {
        selectOption(1, true)
      })
    } else if (apState === 'paused') {
      // Paused — freeze countdown at 100%
      const countdownFill = card.querySelector('.decision-countdown-fill')
      if (countdownFill) countdownFill.style.width = '100%'
    }
  })
}

async function sendOptionSelection(optNum) {
  if (!apSessionId || apState === 'aborted') return

  try {
    await autopilotAmc.session.sendMessage(apSessionId, { text: String(optNum) })
  } catch (err) {
    console.error('[Autopilot] Failed to send option selection:', err)
  }
}

// -- Countdown ---------------------------------------------------------------

function startCountdownBar(fillEl, onExpire) {
  clearCountdown()

  if (!fillEl) {
    onExpire()
    return
  }

  // Set initial width
  fillEl.style.transition = 'none'
  fillEl.style.width = '100%'

  // Force reflow so the browser applies the 100% width first
  void fillEl.offsetWidth

  // Start the CSS transition to 0%
  fillEl.style.transition = `width ${AP_COUNTDOWN_SECONDS}s linear`
  fillEl.style.width = '0%'

  apCountdownTimer = setTimeout(() => {
    apCountdownTimer = null
    onExpire()
  }, AP_COUNTDOWN_SECONDS * 1000)
}

function clearCountdown() {
  if (apCountdownTimer) {
    clearTimeout(apCountdownTimer)
    apCountdownTimer = null
  }
}

// -- Step Group Helpers ------------------------------------------------------

function getCurrentStepGroupBody() {
  const feed = document.getElementById('autopilot-decision-feed')
  // Find existing group for current step
  let group = feed.querySelector(`.step-group[data-step-index="${apCurrentStepIndex}"]`)
  if (group) return group.querySelector('.step-group-body')

  // No group yet — create one (happens for step 1 which doesn't get a transition card)
  const stepDef = V3_STEPS[apCurrentStepIndex]
  if (!stepDef) return feed // fallback to feed itself

  group = document.createElement('div')
  group.className = 'step-group'
  group.dataset.stepIndex = apCurrentStepIndex

  group.innerHTML = `
    <div class="step-group-header">
      <span class="step-group-icon">&#9654;</span>
      <span>Step ${stepDef.order}: ${escapeHtml(stepDef.title)}</span>
      <span class="step-group-count"></span>
    </div>
    <div class="step-group-body"></div>
  `

  feed.appendChild(group)
  return group.querySelector('.step-group-body')
}

function updateStepGroupCount(stepIndex) {
  const feed = document.getElementById('autopilot-decision-feed')
  const group = feed.querySelector(`.step-group[data-step-index="${stepIndex}"]`)
  if (!group) return
  const count = group.querySelectorAll('.decision-card').length
  const countEl = group.querySelector('.step-group-count')
  if (countEl) countEl.textContent = count > 0 ? `${count} decision${count !== 1 ? 's' : ''}` : ''
}

// -- Progress + Transition Cards ---------------------------------------------

function addProgressCard(content) {
  const feed = document.getElementById('autopilot-decision-feed')
  const emptyEl = feed.querySelector('.decision-feed-empty')
  if (emptyEl) emptyEl.remove()

  // Truncate long progress content
  const displayText = content.length > 300
    ? content.substring(0, 297) + '...'
    : content

  const card = document.createElement('div')
  card.className = 'progress-update-card'
  card.textContent = displayText

  const body = getCurrentStepGroupBody()
  body.appendChild(card)
  feed.scrollTop = feed.scrollHeight
}

function addStepTransitionCard(stepDef) {
  const feed = document.getElementById('autopilot-decision-feed')

  // Create a step group container for this step's cards
  const group = document.createElement('div')
  group.className = 'step-group'
  group.dataset.stepIndex = stepDef.order - 1

  group.innerHTML = `
    <div class="step-group-header">
      <span class="step-group-icon">&#9654;</span>
      <span>Step ${stepDef.order}: ${escapeHtml(stepDef.title)}</span>
      <span class="step-group-count"></span>
    </div>
    <div class="step-group-body"></div>
  `

  feed.appendChild(group)
  feed.scrollTop = feed.scrollHeight
}

// -- Auto-continue (no options found) ----------------------------------------

function waitAndContinue() {
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      if (apState !== 'running' || !apSessionId) {
        resolve()
        return
      }
      try {
        await autopilotAmc.session.sendMessage(apSessionId, {
          text: 'Continue with your best recommendation. Present your next decisions with numbered options.',
        })
      } catch (err) {
        console.warn('[Autopilot] Auto-continue failed:', err)
      }
      resolve()
    }, AP_CONTINUE_DELAY)

    // If paused, wait for resume (the timeout still fires, but the guard checks state)
    if (apState === 'paused') {
      clearTimeout(timer)
      // Will be re-triggered on resume by the polling loop
      resolve()
    }
  })
}

// -- Step Auto-Completion ----------------------------------------------------

async function autoCompleteStep() {
  if (apState === 'aborted' || apState === 'done') return

  const step = apSteps[apCurrentStepIndex]
  const stepDef = V3_STEPS[apCurrentStepIndex]

  try {
    // Get all assistant messages for this step
    const messages = await autopilotAmc.db.query('messages', {
      where: { step_id: step.id, role: 'assistant' },
      orderBy: { created_at: 'asc' },
    })

    const generatedContent = messages.map((m) => m.content).join('\n\n')
    const contextSummary = messages.length > 0 ? messages[messages.length - 1].content : ''

    // Mark step complete
    await autopilotAmc.db.update('steps', step.id, {
      is_completed: 1,
      generated_content: generatedContent,
      context_summary: contextSummary,
    })

    // Update local reference
    step.is_completed = 1
    step.generated_content = generatedContent
    step.context_summary = contextSummary

    // Stop session
    if (apSessionId) {
      autopilotAmc.session.stop(apSessionId).catch(() => {})
      apSessionId = null
    }

    // Update PRD progress
    const completedCount = apSteps.filter((s) => s.is_completed).length
    const progress = Math.round((completedCount / apSteps.length) * 100)
    const nextStepOrder = Math.min(step.order + 1, V3_STEPS.length)

    await autopilotAmc.db.update('prds', apPrd.id, {
      current_step: nextStepOrder,
      progress,
    })

    pushSidebarItems()
    updateStepRailState()
    await persistAutopilotState()

    // Advance to next step
    const nextIndex = apCurrentStepIndex + 1
    if (nextIndex < V3_STEPS.length) {
      await runAutopilotStep(nextIndex)
    } else {
      // All steps done (shouldn't reach here — decomposer handles final completion)
      await finishAutopilot()
    }
  } catch (err) {
    console.error('[Autopilot] Step completion failed:', err)
    handleAutopilotError('Step completion failed: ' + (err.message || err))
  }
}

// -- Decomposer (Step 13) ---------------------------------------------------

async function runAutopilotDecomposer(step, stepDef) {
  if (apState === 'aborted') return

  apState = 'completing'
  updateStatusStrip('Decomposer — Generating Files', 0, 0)

  try {
    // Build export folder path from folder selected during intake
    if (apParentFolder) {
      apExportFolder = apParentFolder + '/' + apProjectName
    } else {
      console.error('[Autopilot] No parent folder set — decomposer cannot write files')
      handleAutopilotError('No project folder was selected. Please restart autopilot and choose a folder.')
      return
    }

    // Check for existing decomposer progress (resume scenario)
    const existingFiles = await autopilotAmc.db.query('prd_files', {
      where: { prd_id: apPrd.id },
      orderBy: { order: 'asc' },
    })
    const existingFileNames = new Set(existingFiles.map((f) => f.file_name))

    // Check if we have a saved file plan from a previous attempt
    const savedCtx = apPrd.project_context?.autopilot?.decomposer
    let fileNames

    if (savedCtx && savedCtx.plannedFiles && savedCtx.plannedFiles.length > 0) {
      // Resume — use the saved plan
      fileNames = savedCtx.plannedFiles
      addProgressCard(`Resuming decomposer — ${existingFileNames.size}/${fileNames.length} files already generated`)
    } else {
      // Fresh start — plan the files
      const systemPrompt = await buildAutopilotSystemPrompt(step, stepDef)

      const planningPrompt =
        `You are the Decomposer for "${apPrd.title}". ` +
        `Based on the complete PRD context from all 12 steps, plan the file structure.\n\n` +
        `List ONLY the filenames you will generate, one per line. Use the format:\n` +
        `00_README.md\n01_Auth.md\n02_Database_Schema.md\n...\n\n` +
        `Rules:\n` +
        `- Start with foundation: 00_README.md, 01_Auth.md, 02_Database_Schema.md, 03_API_Endpoints.md, 04_UI_Design_System.md\n` +
        `- Then features in build order: 05_Feature.md, 06_Feature.md, etc.\n` +
        `- End with XX_Future_Features.md for deferred items\n` +
        `- Target 15-25 files total\n` +
        `- Output ONLY filenames, no descriptions or commentary`

      updateStatusStrip('Decomposer — Planning files...', 0, 0)
      addProgressCard('Planning file structure...')

      const planResult = await autopilotAmc.session.create({
        prompt: systemPrompt + '\n\n---\n\n' + planningPrompt,
      })
      apSessionId = planResult.sessionId

      const planResponse = await waitForSessionResponse(apSessionId, 120000)
      fileNames = parsePlannedFileNames(planResponse)

      if (fileNames.length === 0) {
        throw new Error('AI did not return any filenames')
      }

      // Persist the plan so resume can use it
      await persistDecomposerPlan(fileNames)
    }

    addProgressCard(`Planned ${fileNames.length} files: ${fileNames.join(', ')}`)

    // Phase 2: Generate each file (skip already-generated ones)
    apCompletedFiles = existingFiles
      .filter((f) => f.file_name !== 'KICKOFF.md')
      .map((f) => ({ name: f.file_name, content: f.content }))
    let allContent = apCompletedFiles.map((f) => `## ${f.name}\n\n${f.content}\n\n`).join('')

    // Spawn a session if we don't have one (resume scenario)
    if (!apSessionId) {
      const systemPrompt = await buildAutopilotSystemPrompt(step, stepDef)
      const resumePrompt = systemPrompt + '\n\n---\n\n' +
        `You are resuming the Decomposer for "${apPrd.title}". ` +
        `The file plan is: ${fileNames.join(', ')}. ` +
        `Files already generated: ${[...existingFileNames].join(', ') || 'none'}. ` +
        `Generate the remaining files one at a time when asked.`
      const planResult = await autopilotAmc.session.create({ prompt: resumePrompt })
      apSessionId = planResult.sessionId
      await waitForSessionResponse(apSessionId, 120000)
    }

    for (let i = 0; i < fileNames.length; i++) {
      if (apState === 'aborted') return

      const fileName = fileNames[i]

      // Skip already-generated files
      if (existingFileNames.has(fileName)) {
        addProgressCard(`Skipped ${fileName} (already generated)`)
        continue
      }

      updateStatusStrip(
        `Decomposer — ${fileName}`,
        i + 1,
        fileNames.length + 1
      )

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
        const content = await sendAndWaitForResponse(apSessionId, filePrompt, 300000)
        allContent += `## ${fileName}\n\n${content}\n\n`
        apCompletedFiles.push({ name: fileName, content })

        // Write to disk
        if (apExportFolder) {
          await autopilotAmc.export.writeFiles({
            directory: apExportFolder,
            files: [{ name: `docs/planning/${fileName}`, content }],
          })
        }

        // Save to prd_files
        await autopilotAmc.db.insert('prd_files', {
          prd_id: apPrd.id,
          file_name: fileName,
          display_name: fileNameToDisplayName(fileName),
          content,
          order: i,
        })

        // Persist progress after each file
        await persistDecomposerProgress(fileNames, fileName)

        addProgressCard(`Generated ${fileName} (${apCompletedFiles.length}/${fileNames.length})`)
      } catch (err) {
        console.error(`[Autopilot] Failed to generate ${fileName}:`, err)
        addProgressCard(`Failed: ${fileName} -- ${err.message || err}`)
      }
    }

    // Phase 3: Generate KICKOFF.md
    let kickoff = ''
    try {
      updateStatusStrip('Decomposer — Writing KICKOFF.md', fileNames.length + 1, fileNames.length + 1)
      kickoff = generateKickoffPrompt(apPrd.title, apCompletedFiles.map((f) => f.name))

      if (apExportFolder) {
        await autopilotAmc.export.writeFiles({
          directory: apExportFolder,
          files: [{ name: 'KICKOFF.md', content: kickoff }],
        })
      }

      await autopilotAmc.db.insert('prd_files', {
        prd_id: apPrd.id,
        file_name: 'KICKOFF.md',
        display_name: 'KICKOFF',
        content: kickoff,
        order: fileNames.length,
      })
    } catch (err) {
      console.error('[Autopilot] KICKOFF.md generation failed:', err)
      addProgressCard('Warning: KICKOFF.md generation failed — continuing')
    }

    // Phase 4: Save messages + complete step + complete PRD (always runs)
    try {
      await autopilotAmc.db.insert('messages', {
        step_id: step.id,
        prd_id: apPrd.id,
        role: 'assistant',
        content: allContent,
      })
    } catch (err) {
      console.warn('[Autopilot] Failed to save messages:', err)
    }

    try {
      await autopilotAmc.db.update('steps', step.id, {
        is_completed: 1,
        generated_content: allContent,
        context_summary: `Decomposed into ${apCompletedFiles.length} files: ${apCompletedFiles.map((f) => f.name).join(', ')}`,
      })
    } catch (err) {
      console.error('[Autopilot] Failed to complete decomposer step:', err)
    }

    // Stop session
    if (apSessionId) {
      autopilotAmc.session.stop(apSessionId).catch(() => {})
      apSessionId = null
    }

    try {
      await autopilotAmc.db.update('prds', apPrd.id, {
        current_step: V3_STEPS.length,
        progress: 100,
        status: 'completed',
        export_folder: apExportFolder || null,
      })
    } catch (err) {
      console.error('[Autopilot] Failed to complete PRD:', err)
    }

    // Auto-create AMC project (best-effort)
    let createdProjectId = null
    if (apExportFolder) {
      try {
        const existing = await autopilotAmc.project.findByFolder(apExportFolder)
        if (existing) {
          createdProjectId = existing.id
        } else {
          const proj = await autopilotAmc.project.create({
            name: apProjectName,
            folderPath: apExportFolder,
          })
          createdProjectId = proj?.id || proj?.projectId || null
        }
      } catch (err) {
        console.warn('[Autopilot] Failed to auto-create AMC project:', err)
      }
    }

    pushSidebarItems()
    await finishAutopilot(kickoff, createdProjectId)
  } catch (err) {
    console.error('[Autopilot] Decomposer failed:', err)
    handleAutopilotError('File generation failed: ' + (err.message || err))
  }
}

// -- Completion View ---------------------------------------------------------

async function finishAutopilot(kickoffContent, projectId) {
  apState = 'done'
  stopAutopilotPolling()
  stopElapsedTimer()
  clearCountdown()
  await persistAutopilotState()

  showView('completion-view')

  // Hero section
  document.getElementById('completion-project-name').textContent = apProjectName
  document.getElementById('completion-summary').textContent = apIntakeSummary.length > 120
    ? apIntakeSummary.substring(0, 117) + '...'
    : apIntakeSummary
  document.getElementById('completion-time').textContent = 'Completed in ' + formatElapsed(apElapsedSeconds)

  // Decision timeline
  renderDecisionTimeline()

  // File list
  renderCompletionFiles()

  // Wire buttons
  const buildBtn = document.getElementById('completion-build-btn')
  const doneBtn = document.getElementById('completion-done-btn')

  buildBtn.replaceWith(buildBtn.cloneNode(true))
  doneBtn.replaceWith(doneBtn.cloneNode(true))

  document.getElementById('completion-build-btn').addEventListener('click', async () => {
    if (projectId && kickoffContent) {
      try {
        await autopilotAmc.session.launchWithDraft({
          projectId,
          draftText: kickoffContent,
        })
        autopilotAmc.toast.show({ type: 'success', message: 'Session created with kickoff prompt' })
      } catch (err) {
        console.error('[Autopilot] Build This Now failed:', err)
        autopilotAmc.toast.show({ type: 'error', message: 'Failed to launch build session: ' + (err.message || err) })
      }
    } else {
      autopilotAmc.toast.show({
        type: 'warning',
        message: 'No project was created — open the PRD viewer to export and build',
      })
    }
  })

  document.getElementById('completion-done-btn').addEventListener('click', () => {
    apState = 'idle'
    showView('dashboard-view')
    loadDashboard()
  })
}

function renderDecisionTimeline() {
  const container = document.getElementById('completion-timeline')
  container.innerHTML = ''

  // Group decisions by step
  const byStep = {}
  for (const d of apDecisionLog) {
    if (!byStep[d.stepIndex]) byStep[d.stepIndex] = []
    byStep[d.stepIndex].push(d)
  }

  for (const [stepIdx, decisions] of Object.entries(byStep)) {
    const stepDef = V3_STEPS[parseInt(stepIdx, 10)]
    if (!stepDef) continue

    const group = document.createElement('div')
    group.className = 'timeline-step'

    let decisionsHtml = ''
    for (const d of decisions) {
      const selectedText = d.options[d.selected - 1] || `Option ${d.selected}`
      const badge = d.auto ? 'Auto' : 'Manual'
      decisionsHtml += `
        <div class="timeline-decision">
          <strong>R${d.round}:</strong> ${escapeHtml(selectedText)} <em>(${badge})</em>
        </div>
      `
    }

    group.innerHTML = `
      <div class="timeline-step-header">
        <span>${escapeHtml(stepDef.title)}</span>
        <span class="timeline-step-count">${decisions.length} decision${decisions.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="timeline-step-decisions">${decisionsHtml}</div>
    `

    // Toggle expand
    group.querySelector('.timeline-step-header').addEventListener('click', () => {
      group.classList.toggle('expanded')
    })

    container.appendChild(group)
  }

  if (apDecisionLog.length === 0) {
    container.innerHTML = '<div style="color: var(--surface-500); font-size: 13px;">No decisions recorded</div>'
  }
}

function renderCompletionFiles() {
  const container = document.getElementById('completion-files')
  container.innerHTML = ''

  for (const file of apCompletedFiles) {
    const item = document.createElement('div')
    item.className = 'completion-file-item'
    item.innerHTML = `
      <svg class="completion-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span>${escapeHtml(fileNameToDisplayName(file.name))}</span>
    `
    container.appendChild(item)
  }

  // Add KICKOFF.md
  const kickoffItem = document.createElement('div')
  kickoffItem.className = 'completion-file-item'
  kickoffItem.innerHTML = `
    <svg class="completion-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
    <span>KICKOFF.md</span>
  `
  container.appendChild(kickoffItem)
}

// -- Error Handling ----------------------------------------------------------

function handleAutopilotError(message) {
  if (apState === 'aborted' || apState === 'done') return

  apState = 'paused'
  const pauseBtn = document.getElementById('ap-pause-btn')
  if (pauseBtn) pauseBtn.textContent = 'Resume'

  // Show error in status strip
  const nameEl = document.getElementById('ap-step-name')
  if (nameEl) nameEl.textContent = 'Error: ' + message

  // Add error card to feed
  const feed = document.getElementById('autopilot-decision-feed')
  const card = document.createElement('div')
  card.className = 'progress-update-card'
  card.style.borderColor = 'var(--prd-danger, #ef4444)'
  card.style.color = 'var(--prd-danger, #ef4444)'
  card.textContent = message
  feed.appendChild(card)
  feed.scrollTop = feed.scrollHeight

  autopilotAmc.toast.show({ type: 'error', message })
}

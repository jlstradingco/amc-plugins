<p align="center">
  <h1 align="center">AMC Plugin Marketplace</h1>
  <p align="center">Plugin registry and distribution for Agent Mission Control</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-active-brightgreen" alt="Status" />
  <img src="https://img.shields.io/badge/schema-v1-blue" alt="Schema Version" />
</p>

---

## Overview

Central repository for Agent Mission Control (AMC) plugins. AMC fetches `registry.json` to discover available plugins and downloads them on demand to the user's local `userData/plugins/` directory.

## Structure

```
amc-plugins/
├── registry.json              # Plugin catalog (fetched by AMC)
└── plugins/
    ├── prdstack/              # AI-guided PRD creation
    │   ├── manifest.json
    │   ├── ui/
    │   └── prompts/
    └── repoguard/             # Repo health scoring & security scanning
        ├── manifest.json
        └── ui/
```

## Registry Schema

```jsonc
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "prdstack",           // Unique plugin identifier
      "name": "PRD Stack",        // Display name
      "version": "1.0.0",         // Semver version
      "author": "JLS Trading Co",
      "description": "...",
      "icon": "file-text",        // Lucide icon name
      "category": "planning",     // planning | development | productivity
      "license": "free",          // free | premium
      "minAppVersion": "0.1.28",  // Minimum AMC version required
      "files": [                  // Files to download on install
        "manifest.json",
        "ui/index.html",
        "ui/plugin.js"
      ]
    }
  ]
}
```

## Available Plugins

| Plugin | Category | Description |
|--------|----------|-------------|
| **PRD Stack** | Planning | AI-guided PRD creation through structured interview steps |
| **RepoGuard** | Development | Repo health scoring, security scanning, and runtime monitoring |

## Adding a Plugin

1. Create a directory under `plugins/<id>/`
2. Add `manifest.json` following the [plugin manifest schema](https://github.com/jlstradingco/Agent-Orchestrator)
3. Add UI files under `ui/`
4. Register in `registry.json` with all file paths listed in the `files` array
5. Commit and push — AMC clients will pick up the new plugin on next marketplace refresh

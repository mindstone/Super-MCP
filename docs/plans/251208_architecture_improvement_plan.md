# Super-MCP Architecture Improvement Plan

## Executive Summary

This document tracks the ongoing refactoring effort to improve modularity, testability, and long-term maintainability of the super-mcp codebase.

**Progress:** 3 of 5 phases completed (Phases 4 & 5 skipped as low-impact).

---

## Completed Work

### ✅ Phase 1: Extract Tool Handlers (COMPLETED)
**Date:** 2025-12-08

**Results:**
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| `server.ts` | 2,031 lines | 402 lines | **-80%** |

**Files created:**
- `handlers/listToolPackages.ts` (58 lines)
- `handlers/listTools.ts` (62 lines → now 79 lines)
- `handlers/useTool.ts` (276 lines → now 288 lines)
- `handlers/healthCheck.ts` (135 lines)
- `handlers/authenticate.ts` (325 lines)
- `handlers/getHelp.ts` (446 lines)
- `handlers/index.ts` (6 lines)

**Dead code removed from server.ts:**
- `handleAuthStatus` - never called
- `handleReconnectPackage` - never called
- `handleAuthenticateAll` - never called

---

### ✅ Dead Code Removal: Auth System (COMPLETED)
**Date:** 2025-12-08

**Files deleted:**
- `auth/browserOAuthProvider.ts` (446 lines) - Never imported anywhere
- `auth/manager.ts` (251 lines) - Methods never called
- `auth/deviceCode.ts` (158 lines) - Only used by dead manager.ts
- `auth/globalOAuthLock.ts` (149 lines) - Subsequently removed

**Files modified:**
- `registry.ts` - Removed `authManager` field and `getAuthManager()` method

---

### ✅ Phase 2: Extract OAuth Providers (COMPLETED)
**Date:** 2025-12-10

**Results:**
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| `httpClient.ts` | 622 lines | 357 lines | **-43%** |

**Files created:**
- `auth/providers/simple.ts` (190 lines) - `SimpleOAuthProvider`
- `auth/providers/refreshOnly.ts` (61 lines) - `RefreshOnlyOAuthProvider`
- `auth/providers/index.ts` (2 lines) - Re-exports

---

## Current Architecture State

### File Size Distribution (Current)

| File | Lines | Status | Notes |
|------|-------|--------|-------|
| `registry.ts` | 644 | ⚠️ Candidate for splitting | Config + client management mixed |
| `handlers/getHelp.ts` | 446 | OK | Help content included |
| `server.ts` | 411 | ✅ Done | Clean routing layer |
| `clients/httpClient.ts` | 357 | ✅ Done | OAuth providers extracted |
| `handlers/authenticate.ts` | 325 | OK | |
| `catalog.ts` | 305 | OK | |
| `security.ts` | 290 | OK | New: security layer |
| `handlers/useTool.ts` | 288 | OK | |
| `clients/stdioClient.ts` | 255 | OK | |
| `configWatcher.ts` | 227 | OK | New: config watching |
| `logging.ts` | 208 | OK | |
| `types.ts` | 192 | OK | |
| `auth/providers/simple.ts` | 190 | ✅ New | Extracted from httpClient |
| `summarize.ts` | 182 | OK | |
| `cli.ts` | 167 | OK | |
| `handlers/healthCheck.ts` | 135 | OK | |
| `auth/callbackServer.ts` | 112 | OK | |
| `validator.ts` | 95 | OK | |
| `handlers/listTools.ts` | 79 | OK | |
| `auth/providers/refreshOnly.ts` | 61 | ✅ New | Extracted from httpClient |
| `handlers/listToolPackages.ts` | 58 | OK | |
| `utils/portFinder.ts` | 46 | OK | |
| `handlers/index.ts` | 6 | OK | |
| `auth/providers/index.ts` | 2 | OK | |

**Total: 5,081 lines**

### Current Directory Structure

```
src/
├── server.ts              # 411 lines - MCP server + routing ✅
├── registry.ts            # 644 lines - Config + clients (candidate for split)
├── catalog.ts             # 305 lines
├── cli.ts                 # 167 lines
├── configWatcher.ts       # 227 lines (new)
├── logging.ts             # 208 lines
├── security.ts            # 290 lines (new)
├── summarize.ts           # 182 lines
├── types.ts               # 192 lines
├── validator.ts           # 95 lines
│
├── handlers/              # ✅ Tool handlers
│   ├── index.ts
│   ├── listToolPackages.ts
│   ├── listTools.ts
│   ├── useTool.ts
│   ├── healthCheck.ts
│   ├── authenticate.ts
│   └── getHelp.ts
│
├── clients/
│   ├── httpClient.ts      # 357 lines ✅ (OAuth extracted)
│   └── stdioClient.ts     # 255 lines
│
├── auth/
│   ├── callbackServer.ts  # 112 lines
│   └── providers/         # ✅ NEW - OAuth providers
│       ├── index.ts
│       ├── simple.ts
│       └── refreshOnly.ts
│
└── utils/
    └── portFinder.ts      # 46 lines
```

---

## Remaining Phases

### Phase 3: Split Registry (Optional)
**Status:** NOT STARTED
**Priority:** P2 - Lower priority now that Phase 2 is done
**Confidence:** 75%

**Current responsibilities in registry.ts (644 lines):**

| Category | Methods | Lines (est.) |
|----------|---------|--------------|
| Config loading | `fromConfigFiles()`, path resolution, merging | ~180 |
| Config normalization | `normalizeConfig()`, `expandEnvironmentVariables()` | ~80 |
| Config validation | `validateConfig()`, `checkForPlaceholders()` | ~60 |
| Client management | `getClient()`, `createAndConnectClient()`, `closeAll()` | ~150 |
| Package retrieval | `getPackages()`, `getPackage()` | ~30 |
| Auth triggers | `reconnectWithAuth()`, `triggerAuthentication()` | ~80 |

**Proposed split:**
```
src/config/
├── loader.ts       # fromConfigFiles(), path resolution, merging
├── normalizer.ts   # normalizeConfig(), expandEnvironmentVariables()
└── validator.ts    # validateConfig(), checkForPlaceholders()

src/clients/
└── manager.ts      # getClient(), closeAll(), connection caching
```

**registry.ts** would become thin facade (~150 lines).

**Decision:** Defer - current 644 lines is manageable and the refactoring carries medium risk.

---

### Phase 4: Extract Help Content (SKIPPED)
**Status:** SKIPPED
**Rationale:** Help is already isolated in `handlers/getHelp.ts` (446 lines). Further splitting would add complexity without meaningful benefit.

---

### Phase 5: Response Formatters (SKIPPED)
**Status:** SKIPPED
**Rationale:** Low impact - response formatting is simple and inline.

---

## Summary

| Phase | Impact | Risk | Effort | Status |
|-------|--------|------|--------|--------|
| 1. Extract Handlers | High | Low | Medium | ✅ **DONE** |
| Dead Code Removal | High | Low | Low | ✅ **DONE** |
| 2. Extract OAuth Providers | Medium | Low | Low | ✅ **DONE** |
| 3. Split Registry | Medium | Medium | High | ⏸️ Deferred |
| 4. Extract Help | Low | Low | Low | ⏭️ Skipped |
| 5. Response Formatters | Low | Low | Low | ⏭️ Skipped |

---

## Success Metrics

| Metric | Target | Current | Status |
|--------|--------|---------|--------|
| `server.ts` lines | < 400 | 411 | ✅ |
| `httpClient.ts` lines | < 400 | 357 | ✅ |
| Largest file | < 700 | 644 (registry.ts) | ✅ |
| Dead code | 0 | 0 | ✅ |

---

## Types Cleanup (Optional)

The following types in `types.ts` are no longer used after dead code removal:
- `BeginAuthInput`
- `BeginAuthOutput`
- `AuthStatusInput`
- `AuthStatusOutput`
- `AuthManager` interface

These can be removed but have no runtime cost (just interface definitions).

---

*Document created: 2025-12-08*
*Last updated: 2025-12-12*
*Progress: Phases 1, 2, and dead code removal complete. Phase 3 deferred.*

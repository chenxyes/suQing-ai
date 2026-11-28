<div align="center">

<img src="./assets/cover.png" alt="SuQing AI · Xiyu AI — Open-source AI companion framework with continuous memory, digital wardrobe & virtual dating" width="100%" />

# SuQing AI · Xiyu AI

**An open-source AI companion framework with continuous memory, an autonomous digital wardrobe, and settleable virtual dating.**

She already secretly likes you — your relationship starts at "flirting", not a cold stranger.
She texts on WeChat and Web, keeps a diary, styles her own outfits and poses as the owner of her wardrobe, goes on settleable virtual dates, and takes true two-person couple photos with you.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status: Active](https://img.shields.io/badge/Status-Active%20Dev-FF8FB8.svg)](#version-history)
[![Cloudflare R2](https://img.shields.io/badge/Storage-Local%20%2F%20Cloudflare%20R2-F38020.svg?logo=cloudflare&logoColor=white)](#cloudflare-r2-storage--asset-sync-optional)

[简体中文](./README.md) | **English**

[Quick Start](#-quick-start) · [What It Does](#what-it-does) · [Wardrobe & Dating](#digital-wardrobe--virtual-dating) · [Providers](#multi-provider-support) · [Deploy](#deploy) · [Architecture & Security](#architecture)

</div>

---

## ⚡ Quick Start

### Path A: Local Bare-Metal (Recommended for full features)

```bash
git clone https://github.com/chenxyes/suQing-ai.git
cd suQing-ai
npm install        # Node.js >= 20 required
npm run setup      # Generates minimal .env and checks better-sqlite3 build toolchain
npm start
```

Open <http://localhost:3000/app/setup.html> → create a local account → configure your model Provider & API key → chat in Web Playground (`/app/playground.html`) or bind WeChat via QR (`/app/bind.html`).

### Path B: Docker Compose

```bash
git clone https://github.com/chenxyes/suQing-ai.git
cd suQing-ai
docker compose up -d
# Open http://localhost:3000/app/setup.html
```

- SQLite data persists under `./data` across restarts
- Custom port: `HOST_PORT=8080 docker compose up -d`

---

## What It Does

**Core positioning**: not a Q&A bot — an architecture combining multimodal LLMs, layered memory, an emotion state machine, a digital wardrobe, and daily rhythms into **a grounded companion with her own taste, schedule, and boundaries**.

> **Design philosophy**: realism comes from **subtraction and restraint**, not sycophancy. The north star is *"offering warmth, surprise, and presence in the gaps of real life"*. Strictly zero NSFW selling points, zero robotic "user" wording in her world, and deterministic guardrails backing every product boundary.

### 👗 Digital Wardrobe, Pose Library & Stylist Autonomy ⭐

| Capability | One-liner |
|---|---|
| Glass Showcase & 6-Slot Layering | Mix-and-match across `top / outerwear / bottom_or_dress / shoes / bag / accessory`, single-part swap, multi-layer OOTD shoots, and in-page HD lightbox comparison |
| 👑 Autonomous Wardrobe Stylist | Every morning at `07:30`, she chooses her own outfit by season, schedule, and mood; click "👑 Let SuQing Style Herself" or say "you pick what to wear today" on WeChat/Web and she picks clothes, pose, and writes a first-person styling note |
| ✂️ Screenshot Garment Extractor (Transparent PNG) | Upload any street-style screenshot → Vision decomposes individual pieces → choose "✨ Transparent Flat-Lay PNG" (native transparency + 4-connected flood-fill matting preserving inner white collars) or "⚡ Zero-cost Raw Save", with optional low-cost `GARMENT_EXTRACT_MODEL` |
| 📸 Visual Pose Library & Pose-Ref Control | 10 solo + 6 couple visual pose cards built in, plus unlimited uploaded pose reference photos (replicates only posture and framing, never copying face or clothes from the pose image) |
| ☁️ Cloudflare R2 Dual-Mode Storage | Zero-dependency native AWS SigV4 client; automatically syncs assets to R2 + custom CDN when configured, seamlessly falls back to local disk otherwise; includes SFW sync script `scripts/sync_posewear_r2.mjs` |
| WeChat Gift Try-On & Delivery Unboxing | Burst-merges WeChat product image + follow-up text; supports instant virtual try-on, gift-and-wear, in-transit parcel tracking (10-min cron auto-unboxing with try-on photo), and "show me today's outfit" photo command |

### 💕 Three-Layer Virtual Dating & Two-Person Couple Photos ⭐

| Capability | One-liner |
|---|---|
| Layer 1 · Presence Modes | Switch between `Long-Distance (recommended) / Digital-Aware / Local` baselines so physical distance never causes false "stood-up" friction |
| Layer 2 · Cloud Dates & Cyber Photos | Send real menus/meals (cloud dining), shop windows (cloud shopping stylist), or empty-seat/scenery photos to generate seamless in-scene photos |
| Layer 3 · Settleable Date Theater | Start naturally via chat or dock; snapshots current wardrobe outfit and locks scene; ending settles into high-weight long-term memory (`importance=8`) and auto-resolves matching open loops |
| True Two-Person Couple Photos | Upload your own portrait reference so date & cyber photos lock `[Image 1 companion, Image 2 you, Image 3 real background, Image 4 current outfit]` together in one frame and log the photo into conversation memory |

### ✨ Aurora Light & Obsidian Dark Liquid Glass UI

| Capability | One-liner |
|---|---|
| Dual Liquid Glass Themes | One-click toggle between Aurora Light and Obsidian Dark liquid glass across both Dashboard and Web Playground |
| Live Character Hero Stage | Left sidebar hero stage displays her latest OOTD try-on photo, active outfit pills, and date badge — syncing live whenever outfits change |
| In-Chat Action Dock | Web Playground footer integrates Date Theater, Send Gift Photo, Background Couple Photo, and Instant Couple Snap with developing shimmer cards and lightbox zoom |

### Who She Is & Her Own Life

| Capability | One-liner |
|---|---|
| Starts at Flirting | Initial affection 35/100; 5 relationship stages gated by real days known and daily caps so affection cannot be brute-forced |
| Concrete Backstory & 90-Day Timeline | 46+ specific life memories generated on creation, plus optional 3-month simulated history and portable JSON export/import |
| Real Sleep & Grounded Daily Schedule | Default 00:30–07:30 quiet sleep; 8–12 daily schedule blocks grounded in open appointments & yesterday's summary, linked to ongoing books/shows |
| Real-World Facts & Body Rhythm | Astronomical solar terms & lunar festivals (incl. leap months); gentle non-sexualized body rhythm evolution (off under minor protection) |
| Human-Like WeChat Cadence | Short ≤15-char multi-bubble bursts, typing indicators, 10s inbound burst coalescing, and authentic incomplete replies |

### Emotions, Memory & Proactive Care

| Capability | One-liner |
|---|---|
| 10-Dim Emotion Machine & Inner OS | Incremental evolution across trust/security/patience/annoyance + private inner monologue before every outer reply for authentic subtext |
| Conflict & Repair Arc ⭐ | Explicit `hurt → cold → withdrawing → repairing` state machine with hard caps (never permanent cold war) and reconciliation memories ([docs/CONFLICT_ARC.md](./docs/CONFLICT_ARC.md)) |
| Memory v2 & Scene Continuity | 7-layer memory with hybrid semantic + lexical recall, forgetting curve, nightly reflection, persistent current scene, and open-loop follow-ups |
| Diaries, Time Capsules & Shared Pacts | First-person & relational diaries, future-unlocking time capsules, HMAC-signed offline letters, and user-taught nicknames/inside jokes |
| Three-Driver Proactive & No-Repeat | Driven by emotion × schedule × time with 14-day material-level cooldowns and attachment-based dignity caps |

### Multimodal & Safety Floor

| Capability | One-liner |
|---|---|
| High-Fidelity Face-Locked Photos ⭐ | Uncropped reference face lock (supports multi-view turnaround sheets), mood/outfit-driven natural expression & light makeup variation, and auto wardrobe sync on daily selfies |
| Voice Emotion & Web Read-Aloud | Inbound WeChat voice ASR + tone emotion recognition; browser TTS narration and microphone input in Web Playground |
| Crisis Intervention & Minor Protection | Self-harm signals immediately step out of character with hotline resources; self-disclosed minors trigger sticky non-toggleable safe mode |
| Privacy Filter & Deterministic Red Lines | Blocks passwords/IDs/cards from storage, redacts phones/addresses, and deterministically blocks breakup threats or guilt-tripping |

See [Wardrobe Architecture](./docs/WARDROBE_AND_TRYON_ARCHITECTURE.md), [Virtual Dating Architecture](./docs/VIRTUAL_DATING_AND_RELATIONSHIP_ARCHITECTURE.md), and [`docs/FEATURES.txt`](./docs/FEATURES.txt).

---

## Digital Wardrobe & Virtual Dating

### Key Flows

```
1. /app/setup.html       Configure Chat / Image / Vision / ASR / TTS / Embedding providers
2. /app/dashboard.html   Main Console:
   · Left "Character Hero Stage" shows her latest OOTD try-on photo & dating badge
   · "👗 Wardrobe & Tools → Digital Wardrobe Showcase":
     - Upload her character reference portrait to lock facial likeness
     - Click "👑 Let SuQing Style Herself" so she chooses her own outfit, pose & styling note
     - Open "✨ Outfit Inspiration → ✂️ Extract from Screenshot" to turn any outfit photo into a transparent PNG on R2
     - Pick any pose card (or upload your own pose photo) for single-item or multi-layer OOTD try-on
   · "💕 Presence & Date Theater": switch presence baseline, upload your portrait, start/settle dates & snap couple photos
3. /app/playground.html  Immersive Web Chat (shares memory, wardrobe & date sessions with WeChat)
4. /app/bind.html        WeChat QR binding (requires iLink developer approval)
```

### Cloudflare R2 Storage & Asset Sync (Optional)

Without R2 configured, all images safely persist under local `data/visuals/`. Add the following to `.env` to enable zero-dependency Cloudflare R2 storage automatically:

```env
# Cloudflare R2 (trailing /<bucket> in R2_ENDPOINT is normalized automatically)
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_BUCKET=suqing-assets
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
# Optional: custom CDN domain (TLS 1.2 recommended) or r2.dev URL; leave blank for authenticated proxy
R2_PUBLIC_URL=https://assets.example.com

# Optional: dedicated low-cost image edit model for transparent garment extraction
GARMENT_EXTRACT_MODEL=
```

Sync curated SFW pose references, seasonal outfits, and full prompt catalogs into your R2 bucket and local SQLite:

```bash
node scripts/sync_posewear_r2.mjs --poses all --costumes 60
```

---

## Multi-Provider Support

Hot-switch any capability in `/app/setup.html` or the Dashboard Model Settings drawer without restarting:

| Capability | Providers | Notes |
|---|---|---|
| **Chat** (11) | DeepSeek · OpenAI · Anthropic · Gemini · xAI · Zhipu · Doubao · Qwen · Kimi · Ernie · Custom OpenAI-compatible gateway | Works with OpenRouter, SiliconFlow, Ollama, and custom relays |
| **Image** (7) | Custom relay (`/images/edits` multi-image `image[]` + `input_fidelity=high` + `background=transparent`) · OpenRouter · 302.ai · OpenAI · Zhipu · Qwen · Doubao · Ernie | Supports multi-ref face locking, 6-slot layering, transparent flat-lays & two-person couple photos |
| **Vision** (9) | Custom relay · Zhipu GLM-4V · OpenAI · Qwen VL · Doubao · Claude · Kimi · StepFun · MiniMax | Chat vision, gift item analysis, multi-garment screenshot decomposition & pose photo analysis |
| **ASR** (8 impl.) | Custom relay · Gemini · OpenAI Whisper · Qwen paraformer · Groq · MiniMax · Azure · Doubao | WeChat voice transcription + tone emotion recognition |
| **TTS** (6) | Custom relay · MiniMax · OpenAI · Azure · Doubao · Qwen CosyVoice · Fish Audio | Browser chat & diary read-aloud |
| **Embedding** (5) | Custom relay · OpenAI · Gemini · Zhipu · Qwen | Hybrid semantic recall for Memory v2 |
| **Search** (4) | Tavily · Brave · SerpAPI · SearXNG | Real-world fact lookup & work verification |

---

## WeChat Integration

Open `/app/bind.html` to scan a live QR code (requires Tencent iLink/ClawBot approval), or run `npm run ilink:login` on headless servers.

| Action | Status |
|---|---|
| Text chat + 10s burst coalescing + typing indicator | ✅ |
| **Gift photo try-on / gift-and-wear / delivery unboxing cron** | ✅ Merges consecutive image + text bursts |
| **Upload your portrait + natural date start/end + two-person couple photos** | ✅ Natural Chinese voice/text triggers |
| **Autonomous stylist picks & "show today's OOTD" photo command** | ✅ Uses her own chosen outfit & pose |
| Daily selfies & proactive scene photos (auto-linked to wearing wardrobe) | ✅ Full uncropped face lock + outfit sync |
| Inbound voice ASR + tone emotion recognition | ✅ |
| Bot outbound voice in WeChat | ❌ Blocked by iLink protocol (works in Web UI) |

---

## Deploy

### Local Development & Frontend CSS

```bash
npm install
npm run build:css      # Rebuild Tailwind CSS after UI style changes
npm start              # Starts server on http://localhost:3000
```

### Production, Single-User Mode & Verification Suite

- Production templates live in [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service), [`deploy/nginx.conf.example`](./deploy/nginx.conf.example), and [`scripts/backup-db.sh`](./scripts/backup-db.sh).
- For private single-user deployments behind your own auth/LAN, set `SINGLE_USER=true` in `.env` (**never expose publicly without authentication**).
- Run verification checks anytime:

```bash
npm run doctor                           # Environment & health diagnostics
npm run lint                             # ESLint checks
npm run check:behavior                   # Behavior runtime & delivery regression
node scripts/wardrobe_tryon_check.mjs    # Wardrobe, face-lock, layering & full-outfit swap tests
node scripts/date_mode_check.mjs         # Three-layer virtual dating & couple photo tests
node scripts/phase4_assets_check.mjs     # R2 SigV4, transparent PNG matting, pose-ref & stylist autonomy tests
node scripts/user_wording_guard.mjs      # Zero forbidden wording guard
npm run check:imports && npm run check:field-drift && npm run check:release
```

---

## Architecture

```
       ┌────────────────────────────────────────────────────────────┐
       │  Web Dashboard / Playground (Aurora & Obsidian)  /  WeChat │
       └──────────────────────────────┬─────────────────────────────┘
                                      │
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Express (index.mjs) + Multi-Tenant iLink Polling Pool               │
  │  ┌──────────────┬───────────────────────┬──────────────────────────┐ │
  │  │ api.mjs      │ bot.mjs / playground  │ plan_tasks.mjs (Cron)    │ │
  │  │ REST & Auth  │ Shared Reply Pipeline │ Schedule/Unbox/07:30OOTD │ │
  │  └──────────────┴───────────┬───────────┴──────────────────────────┘ │
  │                             ↓                                        │
  │  ┌────────────────────────────────────────────────────────────────┐  │
  │  │ Domain: wardrobe.mjs · wardrobe_stylist.mjs · date_mode.mjs    │  │
  │  │         pose_outfit_library.mjs · garment_extractor.mjs        │  │
  │  │         memory_v2.mjs · emotion_state.mjs · reply_review.mjs   │  │
  │  └──────────────────────────┬─────────────────────────────────────┘  │
  │                             ↓                                        │
  │  ┌──────────────────────────┴──────────┬──────────────────────────┐  │
  │  │ ai.mjs → providers/* (Multimodal)   │ storage.mjs (R2 / Local) │  │
  │  │ db.mjs (better-sqlite3 + WAL)       │ visual_identity.mjs      │  │
  │  └─────────────────────────────────────┴──────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────────┘
```

### Directory Layout

```
.
├── index.mjs                         Express entry + iLink polling pool
├── src/
│   ├── wardrobe.mjs                  Digital wardrobe, intent detection, 6-slot layering, try-on & delivery cron
│   ├── wardrobe_stylist.mjs          Autonomous Wardrobe Owner stylist engine & 07:30 morning OOTD
│   ├── pose_outfit_library.mjs       Solo/couple pose catalog & curated outfit lookbook (built-in + custom)
│   ├── garment_extractor.mjs         Screenshot multi-item decomposition, transparent PNG flat-lay & pose analyzer
│   ├── storage.mjs                   Zero-dependency Cloudflare R2 (AWS SigV4) + local fallback storage
│   ├── date_mode.mjs                 Three-layer presence modes, cloud dates, settleable date theater & couple photos
│   ├── visual_identity.mjs           Reference portrait management & face lock
│   ├── photo_sender.mjs              Daily/proactive photo pipeline (auto-linked to active wardrobe)
│   ├── companion.mjs / reply_*.mjs   18-section persona prompt, context packet & grounded reply review
│   ├── memory_v2.mjs / emotion_state.mjs / relationship_arc.mjs
│   ├── bot.mjs / playground.mjs / api.mjs / plan_tasks.mjs / db.mjs
│   └── providers/                    Chat / Image / Vision / ASR / TTS / Embedding / Search
├── public/app/                       Aurora/Obsidian dual-theme UI (dashboard / playground / pose-previews.js …)
├── scripts/                          CI gates, regression suites (wardrobe / date_mode / phase4_assets) & R2 sync
├── docs/                             Architecture docs (wardrobe / dating / conflict arc / roadmap)
├── TODO.md & CHANGELOG.md            Roadmap checklist & detailed changelog
└── data/                             Runtime SQLite & local visuals (gitignored)
```

---

## Security & Compliance

- **Credential isolation**: `.env`, `.auth-secret`, `.admin-credentials`, `.weixin-credentials.json`, and `data/bot.db*` are all gitignored. Set an explicit ≥32-char `AUTH_SECRET` in production.
- **SSRF & ownership hardening**: External image fetches pass through `src/security/netguard.mjs`; companion and wardrobe endpoints enforce account ownership against IDOR.
- **Operator compliance**: The MIT license covers source code only. Public deployments must provide their own privacy policy, AI-content labeling, moderation API, and verify upstream provider ToS. Built-in crisis intervention and sticky minor protection do not replace formal age verification.

---

## Version History

See [`CHANGELOG.md`](./CHANGELOG.md) for the complete changelog and [`TODO.md`](./TODO.md) for the active roadmap.

- **v1.23.0 (2026-11-28 · Digital Wardrobe × Virtual Dating × Stylist Autonomy × Cloudflare R2)**:
  - **Digital Wardrobe & Glass Showcase**: 6-slot layering, full uncropped face-lock try-on, WeChat image-burst merging, scheduled parcel unboxing, and weekend wear callbacks.
  - **Three-Layer Virtual Dating & Two-Person Couple Photos**: LDR/Digital presence baselines, cloud dining/shopping, settleable date theater (`importance=8` memories + open-loop resolution), two-person couple photos, and full WeChat/Web parity.
  - **Pose/Outfit Library, Transparent PNG Extraction & R2 Storage**: 10 solo + 6 couple visual pose cards with custom photo uploads, screenshot garment extraction to true transparent PNGs, zero-dependency Cloudflare R2 SigV4 storage + CDN, and Aurora Light / Obsidian Dark Liquid Glass UI.
  - **👑 Autonomous Wardrobe Stylist**: Daily `07:30` morning OOTD self-styling, one-click Dashboard button, natural WeChat/Web delegation & "show today's OOTD" photo command, plus first-person styling notes injected into conversation memory.
- **v1.22.0 Her life has real objects + memory fix**: body rhythm evolution, astronomical solar terms & lunar festivals, cross-day books/shows continuity, persistent scene & appointment continuity, and three-bucket proactive dead-man switch.
- **v1.21.x Conflict & repair arc + engineering hardening**: explicit conflict/repair state machine, ESLint & error-signature digest, immersion hygiene (zero "user" wording), photo category calibration & promise fulfilment chain.
- **v1.20.x Safety wrap-up**: sticky minor protection, full-entry privacy filter, release-consistency CI, and realistic skin photo realism v2.
- **v1.0 → v1.19 Core foundation**: 18-section persona engine, Memory v2, 10-dim emotion machine, Inner OS, sleep & daily schedules, multi-provider abstraction, and WeChat iLink integration.

---

## License

[MIT](./LICENSE) © 2026 SuQing AI / Xiyu AI Contributors

This repository **does not ship** any copyrighted third-party sticker or gallery image assets; prepare your own licensed assets if enabling those features.

<div align="center">

[⬆ Back to top](#suqing-ai--溪语-ai) · [简体中文](./README.md)

</div>

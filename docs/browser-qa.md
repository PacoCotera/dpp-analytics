# Browser QA systems

DPP Analytics has **two separate Playwright systems**. They are complementary and must not be confused or substituted for one another.

## Capability and ownership

| System | Location and execution | Purpose | Browser and viewport contract | Network path |
| --- | --- | --- | --- | --- |
| Repository/CI Playwright | `qa/`, built from `qa/Dockerfile` and run by GitHub Actions during deployment or selected quality workflows | Automated, repeatable regression and release-gate checks. Its scenarios and viewport matrix are defined in source and run without an interactive ChatGPT session. | Fixed, code-defined scenarios. The current suite includes Chromium and selected WebKit/mobile coverage, but it is not an ad-hoc parameterized browser service. | Normally exercises the deployed board from the self-hosted runner/host network and published production port. |
| Standalone DPP Playwright | Private repository `PacoCotera/playwright-dpp-config`; self-hosted service connected to ChatGPT as **DPP Playwright** | Interactive production audit, navigation, visual acceptance, investigation and exact reproduction at user-selected browser engines and dimensions. | `browser_engine`: `chromium`, `firefox`, `webkit`; `device_mode`: `desktop`, `mobile`; paired exact `viewport_width` 240–3840 and `viewport_height` 240–2160. Chromium mobile preserves Pixel 5 emulation; WebKit mobile preserves iPhone 12 emulation; Firefox mobile is unsupported. | The host has public-internet egress and can inspect the public production URL and other permitted public IPs/hosts. The MCP service itself is **not publicly exposed**: ports `8931` and `8932` remain loopback-only and ChatGPT reaches them through the private OpenAI Secure MCP Tunnel. |

The CI suite may contain more than one engine or viewport, but its matrix is predetermined by repository code. “Standalone” means the persistent, interactive ChatGPT service with engine/device/viewport parameters; it does not mean the CI container.

## Decision rule

- Use CI Playwright for automatic regression, deterministic fixtures and the deployment gate.
- Use standalone DPP Playwright when a human asks to browse/audit production, when exact browser or viewport parameters matter, or when visual and interaction evidence must be gathered interactively.
- Never claim that CI passing is a completed production visual audit.
- Never claim that a standalone inspection replaces the CI release gate.
- For post-deployment UI acceptance, use the standalone runner against the public production URL, not a local render, container-only URL or rewritten DOM.
- Record the deployed SHA and active asset revision before accepting screenshots or interaction evidence.
- Close every standalone `browser_id` after the inspection so the bounded handle pool is not exhausted.
- When inspecting Amazon, never click sponsored results.

## Standalone session matrix

Use the smallest matrix that proves the requested change. A final cross-engine UI acceptance normally includes:

| Engine | Mode | Example exact viewport | Notes |
| --- | --- | --- | --- |
| Chromium | desktop | 1600 × 1000 | Primary desktop interaction and wide-layout review. |
| Chromium | mobile | 393 × 852 | Pixel 5 device behavior retained with exact CSS dimensions. |
| Firefox | desktop | 1366 × 768 | Desktop engine comparison; no native mobile profile. |
| WebKit | desktop | 1440 × 900 | Safari-engine comparison. |
| WebKit | mobile | 390 × 844 | iPhone 12 behavior retained with exact CSS dimensions. |

The width and height must be supplied together. The session response and `browser_session_info`/`browser_session_list` return the effective engine, device mode and viewport; verify those values rather than assuming the request was applied.

## ChatGPT connection and schema refresh

The standalone stack is deployed from `PacoCotera/playwright-dpp-config` by **Deploy Playwright DPP stack** on the self-hosted runner labeled `playwright-dpp`. The connected ChatGPT developer app is named **DPP Playwright** and uses the existing `playwright-dpp` Secure MCP Tunnel with no application-level OAuth.

After any change to tool names, descriptions, input schemas, annotations or server metadata:

1. Merge and deploy the exact `playwright-dpp-config` commit.
2. Confirm the workflow's staged host audit passes for the facade image, proxy, tunnel and local health endpoints.
3. In ChatGPT, open **Settings → Plugins → DPP Playwright** and select **Refresh**. If the app is absent, choose **Create app → Tunnel**, select `playwright-dpp`, select **No Auth**, create **DPP Playwright**, and connect it.
4. Inspect the imported `browser_session_create` schema. It must show all three engines, both device modes and the paired viewport fields with their bounds.
5. Start a **new conversation** and confirm DPP Playwright appears in the tool menu. Existing conversations do not hot-load a newly created or refreshed tool registry.
6. Run a parameterized session and verify the effective engine/device/viewport returned by the service.

Restarting the server or tunnel alone does not refresh ChatGPT's stored tool metadata. A successful host deployment without the ChatGPT-side Refresh step is incomplete whenever the advertised schema changed.

## Standalone deployment source of truth

The standalone repository owns its facade, tunnel profile, loopback proxy, pinned images, validation scripts and host deployment helper. Do not copy those files into `dpp-analytics` or attempt to deploy the standalone service from this repository.

Changes to `facade/server.mjs`, `facade/Dockerfile`, `server/` or the pinned image manifest may require the reviewed root bootstrap documented in `playwright-dpp-config/README.md` before a workflow redeploy can activate a new facade image. The standalone repository's workflow result and host audit are authoritative for that service.

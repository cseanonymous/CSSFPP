# CSSFPP

**CSS Fingerprinting Profiler (CSSFPP)**

CSSFPP is a research artifact for detecting and profiling **CSS-based browser fingerprinting**.  
It accompanies the paper *“CSS Fingerprinting Profiler: Measuring CSS Fingerprinting via Tiered Evidence Aggregation”* and provides tooling to observe how conditional CSS can leak environment-dependent information without relying on JavaScript.

This repository contains:
- a **browser extension** for in-browser CSS fingerprinting detection, and
- **experiment scripts** for large-scale measurement and analysis.

---

## Repository Structure

```text
CSSFPP/
├── extension/        # Browser extension for CSS fingerprinting detection
├── experiments/      # Crawling and analysis scripts
└── README.md
```
Browser Extension (extension/)
Purpose
The CSSFPP browser extension inspects CSS stylesheets during page load to identify fingerprinting-capable CSS structures.
It operates purely at the CSS layer and does not instrument or execute page JavaScript.

The extension detects:

environment-dependent CSS predicates (sources), and

externally observable CSS effects such as conditional resource loading (sinks).

## Installation
Open chrome://extensions/ in a Chromium-based browser (Chrome, Brave, Edge).

Enable Developer mode.

Click Load unpacked.

Select the extension/ directory.

## Usage
Visit a website after installing the extension.

The extension analyzes accessible stylesheets at page load.

Detected CSS fingerprinting evidence is recorded locally and can be exported for analysis.

The extension passively profiles websites, not users.

## Experiments (`experiments/`)

The `experiments/` directory supports two complementary evaluation settings described in the paper.

---

### Experiment 1: Large-scale Measurement

#### Purpose

This experiment measures the prevalence and structure of CSS fingerprinting in the wild.  
It combines automated browsing with the CSSFPP extension to detect fingerprinting-capable CSS across many real-world websites.

#### Workflow

- Launch an automated browser with the CSSFPP extension installed.
- Visit a list of target domains (e.g., top-site lists).
- Collect per-page JSON reports produced by the extension.
- Aggregate and analyze results using scripts in `experiments/`.

#### Output

- Site-level and page-level summaries
- Counts of Tier 1 and Tier 2 evidence
- Aggregated statistics suitable for large-scale analysis

---

### Experiment 2: Controlled Honeypage Validation

#### Purpose

The honeypage experiment validates that CSS alone, without JavaScript, can reliably extract and externalize environment-dependent information.

It serves as a controlled ground-truth experiment to confirm that the conditional CSS dependencies detected in the wild correspond to real, discriminative signals.

#### Design

- A dedicated honeypage is deployed with only static HTML and CSS.
- The page embeds conditional CSS rules that depend on:
  - user and accessibility preferences
  - input and interaction capabilities
  - display characteristics
  - rendering-engine feature support
- When a predicate evaluates to true, it triggers a feature-specific network request.
- No JavaScript, timers, or active measurement code are used.

#### Workflow

- Clients load the honeypage in their browser.
- The browser evaluates conditional CSS rules internally.
- Predicate outcomes are externalized via conditional resource requests.
- A server-side collector records which requests are received.
- Per-visit CSS feature vectors are reconstructed from the request logs.

#### Output

- Binary feature vectors representing CSS predicate outcomes
- Per-feature entropy estimates
- Evidence of cross-browser and cross-platform diversity

This experiment demonstrates that even a small set of declarative CSS predicates can partition clients into multiple distinguishable configurations.


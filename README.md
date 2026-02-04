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

## Experiments (experiments/)
### Purpose
The experiments directory contains scripts to support:

automated browsing with the CSSFPP extension installed,

collection of per-page CSS fingerprinting reports, and

aggregation and analysis across many sites.

These scripts are intended for large-scale measurement studies.

### Typical Workflow
Launch an automated browser with the CSSFPP extension loaded.

Visit a list of target domains.

Collect JSON reports produced by the extension.

Aggregate and analyze results using the scripts in experiments/.

### Requirements
Python 3

Common Python data libraries (e.g., pandas)

An automated browsing framework (e.g., Selenium or Playwright)

Exact dependencies depend on the specific experiment scripts used.

## Detection Model (Summary)
CSSFPP models CSS fingerprinting as relationships between:

Sources: CSS predicates that depend on environment properties
(e.g., user preferences, display capabilities, input capabilities).

Sinks: CSS constructs that trigger externally observable effects
(e.g., conditional network fetches).

Evidence is categorized into two tiers:

Tier 1 (echo-confirmed): predicate information is explicitly reflected in requested resources.

Tier 2 (dependency-confirmed): resource loading is gated by environment-dependent CSS logic without explicit token echo.

Tier 2 evidence is reported conservatively and does not assert definitive tracking intent.

## Output
CSSFPP produces structured JSON artifacts containing:

page and site metadata,

extracted CSS predicates and observable effects,

inferred source–sink relationships, and

per-page summaries suitable for aggregation.

These artifacts are designed for reproducibility and offline analysis.

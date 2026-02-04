# aggregate_dumps.py
# ------------------------------------------------------------
# Usage (PowerShell):
#   python .\aggregate_dumps.py --input "C:\path\to\Downloads" --out ".\agg_out" --dedup
#
# Optional:
#   --formats png pdf
#   --font "Times New Roman"   (or leave default)
#   --topk 10   (top-K semantic groups figure)
# ------------------------------------------------------------

import argparse
import csv
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Iterable, Set

import matplotlib as mpl
import matplotlib.pyplot as plt


DUMP_NAME_RE = re.compile(r"^css_dump_.*\.json$", re.IGNORECASE)


# ------------------------- helpers -------------------------

def safe_int(x, default=0) -> int:
    try:
        if x is None:
            return default
        if isinstance(x, bool):
            return int(x)
        if isinstance(x, (int, float)):
            if isinstance(x, float) and math.isnan(x):
                return default
            return int(x)
        s = str(x).strip()
        if not s:
            return default
        return int(float(s))
    except Exception:
        return default


def safe_str(x, default="") -> str:
    try:
        if x is None:
            return default
        return str(x)
    except Exception:
        return default


def try_load_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore").lstrip()
        if not text.startswith("{"):
            return None
        return json.loads(text)
    except Exception:
        return None


def hostname_from_url(url: str) -> str:
    try:
        if "://" not in url:
            url = "https://" + url
        from urllib.parse import urlparse
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def etld1_naive(host: str) -> str:
    host = (host or "").lower().strip(".")
    if not host:
        return ""
    if host == "localhost":
        return "localhost"
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host):
        return host
    parts = [p for p in host.split(".") if p]
    if len(parts) <= 2:
        return host
    last, second, third = parts[-1], parts[-2], parts[-3]
    common_2lvl = {"co", "com", "net", "org", "ac", "gov", "edu"}
    if len(last) == 2 and second in common_2lvl and third:
        return f"{third}.{second}.{last}"
    return f"{second}.{last}"


def clamp_str(s: str, max_len: int = 60) -> str:
    s = safe_str(s, "")
    if len(s) <= max_len:
        return s
    return s[: max_len - 3] + "..."


def wrap_label(s: str, max_len: int = 18) -> str:
    """
    Soft-wrap long x tick labels into multiple lines.
    Keeps figure readable without truncating too aggressively.
    """
    s = safe_str(s, "")
    if len(s) <= max_len:
        return s
    words = s.split()
    if len(words) == 1:
        return clamp_str(s, max_len + 6)
    lines: List[str] = []
    cur = ""
    for w in words:
        if not cur:
            cur = w
        elif len(cur) + 1 + len(w) <= max_len:
            cur = cur + " " + w
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return "\n".join(lines[:3])


# ------------------------- plot style -------------------------
# Pastel palette (paper-friendly)
PASTEL = {
    "blue":   "#A7C7E7",
    "teal":   "#A8DADC",
    "green":  "#B7E4C7",
    "amber":  "#F6D6AD",
    "purple": "#CDB4DB",
    "pink":   "#F4B6C2",
    "slate":  "#BFC5D2",
    "gray":   "#D6D6D6",
    "navy":   "#457B9D",   # darker accent if needed
}


def setup_plot_style(font_name: str) -> None:
    mpl.rcParams.update({
        "text.usetex": False,
        "mathtext.default": "regular",

        "font.family": "serif",
        "font.serif": ["Times New Roman", "Times", "Nimbus Roman", "DejaVu Serif"],
        "font.size": 11,
        "axes.titlesize": 12,
        "axes.labelsize": 11,
        "xtick.labelsize": 10,
        "ytick.labelsize": 10,
        "legend.fontsize": 10,

        "lines.linewidth": 1.6,
        "lines.markersize": 5,

        "axes.linewidth": 0.8,
        "axes.spines.top": False,
        "axes.spines.right": False,

        "axes.grid": True,
        "grid.color": "0.90",
        "grid.linewidth": 0.8,
        "grid.linestyle": "-",
        "axes.axisbelow": True,

        "figure.dpi": 150,
        "savefig.dpi": 300,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.02,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })

    if font_name:
        mpl.rcParams["font.family"] = "serif"
        mpl.rcParams["font.serif"] = [font_name, "Times New Roman", "Times", "DejaVu Serif"]


def save_figure(fig, out_base: Path, formats: List[str]) -> None:
    out_base.parent.mkdir(parents=True, exist_ok=True)
    for fmt in formats:
        fig.savefig(out_base.with_suffix(f".{fmt}"))


def apply_clean_ticks(ax) -> None:
    ax.tick_params(axis="both", which="both", direction="out", length=3, width=0.8)


def annotate_bar_end(ax, bars, fmt="{:d}", pad_frac=0.02) -> None:
    xmax = 0.0
    for b in bars:
        xmax = max(xmax, float(b.get_width()))
    xpad = xmax * pad_frac if xmax > 0 else 1.0

    for b in bars:
        v = float(b.get_width())
        ax.text(v + xpad, b.get_y() + b.get_height() / 2.0, fmt.format(int(v)),
                va="center", ha="left")

    ax.set_xlim(0, xmax * 1.08 if xmax > 0 else 1.0)


def fig_size(single_col: bool = False, height_ratio: float = 0.45) -> Tuple[float, float]:
    w = 3.33 if single_col else 6.9
    return (w, w * height_ratio)


# ------------------------- mapping / labels -------------------------

VERDICT_LABELS = {
    "likely not fingerprinting": "Not fingerprinting",

    # Tier 1 (echo-confirmed)
    "likely fingerprinting (echo-confirmed)": "Likely fingerprinting (echo-confirmed)",

    # Tier 2 (dependency-confirmed)
    "conditional fetch observed (dependency-confirmed)": "Conditional fetch observed (dependency-confirmed)",
    "potential fingerprinting (dependency-confirmed)": "Fingerprinting-capable CSS structure (dependency-confirmed)",
    "likely fingerprinting (dependency-confirmed)": "Fingerprinting-capable CSS structure (dependency-confirmed)",
}


def pretty_key(k: str, mapping: Dict[str, str]) -> str:
    kk = (k or "").strip()
    if not kk:
        return "Unknown"
    low = kk.lower()
    return mapping.get(low, kk)


def verdict_order() -> List[str]:
    return [
        "Not fingerprinting",
        "Likely fingerprinting (echo-confirmed)",
        "Conditional fetch observed (dependency-confirmed)",
        "Fingerprinting-capable CSS structure (dependency-confirmed)",
        "Unknown",
    ]


# ------------------------- semantic extraction -------------------------

def iter_claimdetails_semantic_groups(data: Dict[str, Any]) -> Iterable[str]:
    cds = data.get("claimDetails")
    if isinstance(cds, list):
        for c in cds:
            if not isinstance(c, dict):
                continue
            sg = c.get("semanticGroup")
            if sg:
                yield str(sg).strip()


def iter_association_semantic_groups(data: Dict[str, Any]) -> Iterable[str]:
    assocs = data.get("associations")
    if not isinstance(assocs, list):
        return
    for a in assocs:
        if not isinstance(a, dict):
            continue
        ms = a.get("matchedSources")
        if not isinstance(ms, list):
            continue
        for s in ms:
            if not isinstance(s, dict):
                continue
            sg = s.get("semanticGroup")
            if sg:
                yield str(sg).strip()


def semantic_group_set(data: Dict[str, Any]) -> Set[str]:
    s = set(x for x in iter_claimdetails_semantic_groups(data) if x)
    if s:
        return s
    return set(x for x in iter_association_semantic_groups(data) if x)


# ------------------------- data model -------------------------

@dataclass
class SiteRow:
    file: str
    page: str
    page_host: str
    page_etld1: str

    verdict: str

    risk_score: int
    risk_level: str

    sheets_accessible: int
    sheets_inaccessible: int
    total_rules_scanned: int
    total_sources: int
    total_sinks: int
    total_associations: int
    tier1_echo_associations: int
    tier2_dependency_associations: int

    dependency_label: str
    dependency_score: int

    num_distinct_attributes: int
    num_distinct_semantic_groups: int
    num_distinct_sink_hosts: int
    num_third_party_sinks: int
    num_distinct_third_party_sink_hosts: int
    num_identifier_like_sinks: int
    num_distinct_identifier_like_sink_hosts: int


def extract_site_row(path: Path, data: Dict[str, Any]) -> SiteRow:
    page = safe_str(data.get("page", ""))
    page_host = safe_str(data.get("pageHost", "")) or hostname_from_url(page)
    page_etld1 = safe_str(data.get("pageETLD1", "")) or etld1_naive(page_host)

    verdict = safe_str(data.get("verdict", ""))

    risk_score = safe_int(data.get("riskScore", 0))
    risk_level = safe_str(data.get("riskLevel", ""))

    summary = data.get("summary", {}) if isinstance(data.get("summary", {}), dict) else {}

    sheets_accessible = safe_int(summary.get("sheetsAccessible", 0))
    sheets_inaccessible = safe_int(summary.get("sheetsInaccessible", 0))
    total_rules_scanned = safe_int(summary.get("totalRulesScanned", 0))
    total_sources = safe_int(summary.get("totalSources", 0))
    total_sinks = safe_int(summary.get("totalSinks", 0))
    total_associations = safe_int(summary.get("totalAssociations", 0))
    tier1 = safe_int(summary.get("tier1EchoAssociations", 0))
    tier2 = safe_int(summary.get("tier2DependencyAssociations", 0))

    dependency_label = safe_str(summary.get("dependencyLabel", ""))
    dependency_score = safe_int(summary.get("dependencyScore", 0))

    dep_metrics = summary.get("dependencyMetrics", {}) if isinstance(summary.get("dependencyMetrics", {}), dict) else {}
    num_distinct_attributes = safe_int(dep_metrics.get("numDistinctAttributes", 0))
    num_distinct_semantic_groups = safe_int(dep_metrics.get("numDistinctSemanticGroups", 0))
    num_distinct_sink_hosts = safe_int(dep_metrics.get("numDistinctSinkHosts", 0))
    num_third_party_sinks = safe_int(dep_metrics.get("numThirdPartySinks", 0))
    num_distinct_third_party_sink_hosts = safe_int(dep_metrics.get("numDistinctThirdPartySinkHosts", 0))
    num_identifier_like_sinks = safe_int(dep_metrics.get("numIdentifierLikeSinks", 0))
    num_distinct_identifier_like_sink_hosts = safe_int(dep_metrics.get("numDistinctIdentifierLikeSinkHosts", 0))

    return SiteRow(
        file=path.name,
        page=page,
        page_host=page_host,
        page_etld1=page_etld1,

        verdict=verdict,

        risk_score=risk_score,
        risk_level=risk_level,

        sheets_accessible=sheets_accessible,
        sheets_inaccessible=sheets_inaccessible,
        total_rules_scanned=total_rules_scanned,
        total_sources=total_sources,
        total_sinks=total_sinks,
        total_associations=total_associations,
        tier1_echo_associations=tier1,
        tier2_dependency_associations=tier2,

        dependency_label=dependency_label,
        dependency_score=dependency_score,

        num_distinct_attributes=num_distinct_attributes,
        num_distinct_semantic_groups=num_distinct_semantic_groups,
        num_distinct_sink_hosts=num_distinct_sink_hosts,
        num_third_party_sinks=num_third_party_sinks,
        num_distinct_third_party_sink_hosts=num_distinct_third_party_sink_hosts,
        num_identifier_like_sinks=num_identifier_like_sinks,
        num_distinct_identifier_like_sink_hosts=num_distinct_identifier_like_sink_hosts,
    )


def write_csv_rows(rows: List[SiteRow], out_csv: Path) -> None:
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    fields = list(SiteRow.__annotations__.keys())
    with out_csv.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow(r.__dict__)


def save_json(obj: Dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


# ------------------------- plots -------------------------

def plot_classification_outcomes(verdict_counts: Counter, out_base: Path, formats: List[str]) -> None:
    order = verdict_order()
    labels = [k for k in order if verdict_counts.get(k, 0) > 0]
    for k, _v in verdict_counts.most_common():
        if k not in order:
            labels.append(k)

    values = [int(verdict_counts.get(k, 0)) for k in labels]

    bucket_colors = {
        "Not fingerprinting": PASTEL["slate"],
        "Likely fingerprinting (echo-confirmed)": PASTEL["teal"],
        "Conditional fetch observed (dependency-confirmed)": PASTEL["amber"],
        "Fingerprinting-capable CSS structure (dependency-confirmed)": PASTEL["blue"],
        "Unknown": PASTEL["purple"],
    }
    full_colors = [bucket_colors.get(l, PASTEL["green"]) for l in labels]

    fig, ax = plt.subplots(figsize=fig_size(single_col=False, height_ratio=0.42))
    bars = ax.barh(labels[::-1], values[::-1], color=full_colors[::-1], edgecolor="none")

    ax.set_title("Observed CSS conditional structures across measured sites")
    ax.set_xlabel("Number of sites")
    ax.set_ylabel("")

    annotate_bar_end(ax, bars, fmt="{:d}", pad_frac=0.02)
    apply_clean_ticks(ax)

    fig.tight_layout()
    save_figure(fig, out_base, formats)
    plt.close(fig)


def plot_top_semantic_groups_by_verdict(
    per_site_groups: List[Set[str]],
    per_site_verdict_pretty: List[str],
    out_base: Path,
    formats: List[str],
    topk: int = 10,
) -> None:
    overall = Counter()
    per_bucket = defaultdict(Counter)  # bucket -> Counter(group -> sites)

    for groups, bucket in zip(per_site_groups, per_site_verdict_pretty):
        for g in groups:
            overall[g] += 1
            per_bucket[bucket][g] += 1

    top = [g for g, _ in overall.most_common(topk)]
    if not top:
        return

    buckets = [b for b in verdict_order() if b in set(per_site_verdict_pretty)]
    for b in sorted(set(per_site_verdict_pretty)):
        if b not in buckets:
            buckets.append(b)

    vals: List[List[int]] = []
    for g in top:
        row = [int(per_bucket[b].get(g, 0)) for b in buckets]
        vals.append(row)

    fig, ax = plt.subplots(figsize=fig_size(single_col=False, height_ratio=0.55))
    ylabels = [clamp_str(g, 40) for g in top][::-1]

    left = [0] * len(top)

    bucket_colors = {
        "Not fingerprinting": PASTEL["slate"],
        "Likely fingerprinting (echo-confirmed)": PASTEL["teal"],
        "Conditional fetch observed (dependency-confirmed)": PASTEL["amber"],
        "Fingerprinting-capable CSS structure (dependency-confirmed)": PASTEL["blue"],
        "Unknown": PASTEL["purple"],
    }

    for bi, b in enumerate(buckets):
        seg = [vals[i][bi] for i in range(len(top))][::-1]
        ax.barh(
            ylabels,
            seg,
            left=left,
            color=bucket_colors.get(b, PASTEL["green"]),
            edgecolor="none",
            label=b
        )
        left = [l + s for l, s in zip(left, seg)]

    ax.set_title(f"Top semantic groups by site prevalence (top {len(top)})")
    ax.set_xlabel("Number of sites where group appears")
    ax.set_ylabel("")
    apply_clean_ticks(ax)
    ax.legend(loc="lower right", frameon=False)

    fig.tight_layout()
    save_figure(fig, out_base, formats)
    plt.close(fig)

def plot_thirdparty_identifier_by_verdict(
    rows: List[SiteRow],
    verdict_pretty: List[str],
    out_base: Path,
    formats: List[str],
) -> None:
    buckets = [b for b in verdict_order() if b in set(verdict_pretty)]
    for b in sorted(set(verdict_pretty)):
        if b not in buckets:
            buckets.append(b)

    n = Counter()
    thirdp = Counter()
    ident = Counter()

    for r, b in zip(rows, verdict_pretty):
        n[b] += 1
        if r.num_third_party_sinks >= 1:
            thirdp[b] += 1
        if r.num_identifier_like_sinks >= 1:
            ident[b] += 1

    thirdp_frac = [thirdp[b] / n[b] if n[b] else 0.0 for b in buckets]
    ident_frac = [ident[b] / n[b] if n[b] else 0.0 for b in buckets]

    fig, ax = plt.subplots(figsize=fig_size(single_col=False, height_ratio=0.42))

    import numpy as np
    x = np.arange(len(buckets), dtype=float)
    w = 0.38

    ax.bar(
        x - w / 2,
        thirdp_frac,
        width=w,
        color=PASTEL["amber"],
        edgecolor="none",
        label="Third-party sinks",
    )
    ax.bar(
        x + w / 2,
        ident_frac,
        width=w,
        color=PASTEL["blue"],
        edgecolor="none",
        label="Identifier-like sinks",
    )

    ax.set_title("Third-party and identifier-like sinks by verdict bucket", pad=18)
    ax.set_ylabel("Fraction of sites")
    ax.set_ylim(0, 1.0)

    ax.set_xticks(x)
    ax.set_xticklabels([wrap_label(s, 18) for s in buckets], rotation=0, ha="center")

    # Add top space and keep legend away from the title
    fig.subplots_adjust(top=0.82)
    ax.legend(
        frameon=False,
        loc="upper center",
        bbox_to_anchor=(0.5, 1.10),
        ncol=2,
        columnspacing=1.6,
        handlelength=1.8,
    )

    apply_clean_ticks(ax)

    fig.tight_layout()
    save_figure(fig, out_base, formats)
    plt.close(fig)


# ------------------------- main -------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Folder containing css_dump_*.json files")
    ap.add_argument("--out", default="agg_out", help="Output folder")
    ap.add_argument("--dedup", action="store_true", help="Keep one dump per page_host (latest file mtime wins)")
    ap.add_argument("--formats", nargs="+", default=["png"], help="Figure formats, e.g. png pdf")
    ap.add_argument("--font", default="", help="Preferred serif font family, e.g. Times New Roman")
    ap.add_argument("--topk", type=int, default=10, help="Top-K semantic groups to plot")
    args = ap.parse_args()

    setup_plot_style(args.font)

    in_dir = Path(args.input)
    out_dir = Path(args.out)
    plots_dir = out_dir / "plots"

    if not in_dir.exists():
        raise FileNotFoundError(str(in_dir))

    all_files = [p for p in in_dir.iterdir() if p.is_file() and DUMP_NAME_RE.match(p.name)]
    if not all_files:
        print(f"No dump files found in {in_dir}")
        return

    dumps: List[Tuple[Path, Dict[str, Any]]] = []
    bad = 0
    for p in sorted(all_files):
        data = try_load_json(p)
        if not data:
            bad += 1
            continue
        dumps.append((p, data))

    if not dumps:
        print("All files failed to parse as JSON.")
        return

    if args.dedup:
        by_host: Dict[str, Tuple[Path, Dict[str, Any]]] = {}
        for p, d in dumps:
            host = safe_str(d.get("pageHost", "")).lower() or hostname_from_url(safe_str(d.get("page", "")))
            if not host:
                host = f"__nohost__:{p.name}"
            cur = by_host.get(host)
            if cur is None or p.stat().st_mtime > cur[0].stat().st_mtime:
                by_host[host] = (p, d)
        dumps = list(by_host.values())

    rows: List[SiteRow] = [extract_site_row(p, d) for p, d in dumps]
    per_site_sem_groups: List[Set[str]] = [semantic_group_set(d) for _p, d in dumps]

    write_csv_rows(rows, out_dir / "site_level.csv")

    verdict_pretty = [pretty_key(r.verdict, VERDICT_LABELS) for r in rows]
    verdict_counts = Counter(verdict_pretty)

    totals = {
        "num_dumps": len(rows),
        "bad_json_files_skipped": bad,
        "verdict_counts": dict(verdict_counts),
        "sum_tier1_echo_associations": sum(r.tier1_echo_associations for r in rows),
        "sum_tier2_dependency_associations": sum(r.tier2_dependency_associations for r in rows),
        "sum_total_associations": sum(r.total_associations for r in rows),
        "mean_risk_score": sum(r.risk_score for r in rows) / max(1, len(rows)),
        "mean_rules_scanned": sum(r.total_rules_scanned for r in rows) / max(1, len(rows)),
        "mean_sources": sum(r.total_sources for r in rows) / max(1, len(rows)),
        "mean_sinks": sum(r.total_sinks for r in rows) / max(1, len(rows)),
        "share_sites_with_third_party_sinks": (
            sum(1 for r in rows if r.num_third_party_sinks >= 1) / max(1, len(rows))
        ),
        "share_sites_with_identifier_like_sinks": (
            sum(1 for r in rows if r.num_identifier_like_sinks >= 1) / max(1, len(rows))
        ),
    }
    save_json(totals, out_dir / "totals.json")

    print("\n=== Aggregate totals ===")
    print(f"Dumps parsed: {totals['num_dumps']}")
    print(f"Bad JSON skipped: {totals['bad_json_files_skipped']}")

    print("\nClassification outcomes (relabelled):")
    for k, v in verdict_counts.most_common():
        print(f"  {k}: {v}")

    print("\nAssociations:")
    print(f"  Tier1 echo total: {totals['sum_tier1_echo_associations']}")
    print(f"  Tier2 dependency total: {totals['sum_tier2_dependency_associations']}")
    print(f"  Total associations: {totals['sum_total_associations']}")

    # Figures kept:
    #   1) fig_classification_outcomes
    #   2) fig_top_semantic_groups_by_verdict
    #   3) fig_thirdparty_identifier_by_verdict

    plot_classification_outcomes(
        verdict_counts,
        out_base=plots_dir / "fig_classification_outcomes",
        formats=args.formats,
    )

    plot_top_semantic_groups_by_verdict(
        per_site_groups=per_site_sem_groups,
        per_site_verdict_pretty=verdict_pretty,
        out_base=plots_dir / "fig_top_semantic_groups_by_verdict",
        formats=args.formats,
        topk=max(3, int(args.topk)),
    )

    plot_thirdparty_identifier_by_verdict(
        rows=rows,
        verdict_pretty=verdict_pretty,
        out_base=plots_dir / "fig_thirdparty_identifier_by_verdict",
        formats=args.formats,
    )

    print(f"\nWrote outputs to: {out_dir.resolve()}")
    print(f"CSV: { (out_dir / 'site_level.csv').resolve() }")
    print(f"Totals: { (out_dir / 'totals.json').resolve() }")
    print(f"Plots: { plots_dir.resolve() }")


if __name__ == "__main__":
    main()

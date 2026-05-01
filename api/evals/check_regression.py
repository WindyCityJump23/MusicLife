#!/usr/bin/env python3
"""Score regression checker for MusicLife recommendation evals.

Usage:
    python -m evals.check_regression \\
        --current eval-results/report.json \\
        --baseline baseline/report.json \\
        --max-drop 0.1

Exit codes:
    0 — no regression detected (or no baseline to compare against)
    1 — one or more eval scores dropped more than --max-drop from baseline
    2 — usage / file error
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _load_scores(path: Path) -> dict[str, float]:
    """Return a flat {eval_name: score} dict from a run_evals JSON report."""
    data = json.loads(path.read_text())
    scores: dict[str, float] = {}
    for suite in data.get("suites", []):
        for result in suite.get("results", []):
            name = result.get("name")
            score = result.get("score")
            if name is not None and score is not None:
                scores[name] = float(score)
    return scores


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check eval score regressions between two run_evals JSON reports",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--current", required=True, metavar="PATH",
                        help="Path to the current eval report JSON")
    parser.add_argument("--baseline", required=True, metavar="PATH",
                        help="Path to the baseline eval report JSON")
    parser.add_argument("--max-drop", type=float, default=0.1, metavar="DELTA",
                        help="Maximum allowed score drop per eval (default: 0.1)")
    args = parser.parse_args()

    current_path = Path(args.current)
    baseline_path = Path(args.baseline)

    if not current_path.exists():
        print(f"ERROR: current report not found: {current_path}", file=sys.stderr)
        sys.exit(2)

    if not baseline_path.exists():
        print(f"No baseline found at {baseline_path} — skipping regression check.")
        sys.exit(0)

    current_scores = _load_scores(current_path)
    baseline_scores = _load_scores(baseline_path)

    regressions: list[tuple[str, float, float, float]] = []
    for name, baseline_score in baseline_scores.items():
        current_score = current_scores.get(name)
        if current_score is None:
            print(f"  WARN  {name:<45} missing from current report — skipping")
            continue
        drop = baseline_score - current_score
        if drop > args.max_drop:
            regressions.append((name, baseline_score, current_score, drop))

    if not regressions:
        print(
            f"Regression check passed — no eval dropped more than {args.max_drop:.2f} "
            f"from baseline ({len(baseline_scores)} evals checked)."
        )
        sys.exit(0)

    print(f"REGRESSION DETECTED — {len(regressions)} eval(s) dropped > {args.max_drop:.2f}:\n")
    print(f"  {'EVAL':<45} {'BASELINE':>9} {'CURRENT':>9} {'DROP':>7}")
    print(f"  {'-'*45} {'-'*9} {'-'*9} {'-'*7}")
    for name, baseline, current, drop in sorted(regressions, key=lambda t: -t[3]):
        print(f"  {name:<45} {baseline:>9.4f} {current:>9.4f} {drop:>+7.4f}")
    print()
    sys.exit(1)


if __name__ == "__main__":
    main()

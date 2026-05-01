#!/usr/bin/env python3
"""CLI runner for MusicLife recommendation evals.

Usage:
    # From api/ directory:
    python -m evals.run_evals
    python -m evals.run_evals --suite ranking
    python -m evals.run_evals --suite ranking,songs,context
    python -m evals.run_evals --suite all --json /tmp/report.json

Exit codes:
    0 — all evals passed (or skipped)
    1 — one or more evals failed

Suites:
    ranking    Artist-level ranking algorithm (eval_ranking.py)
    songs      Song-level ranking algorithm (eval_songs.py)
    context    Context signal and weight evals (eval_context.py)
    synthesis  Synthesis quality evals (eval_synthesis.py)
    all        Run every suite (default)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

_API_DIR = Path(__file__).parent.parent
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

import evals.eval_context as _ctx
import evals.eval_ranking as _ranking
import evals.eval_songs as _songs
import evals.eval_synthesis as _synth


# ── ANSI colours (disabled on non-TTY) ──────────────────────────

_USE_COLOR = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text


GREEN = "32"
RED = "31"
YELLOW = "33"
CYAN = "36"
BOLD = "1"
DIM = "2"


# ── Suite registry ───────────────────────────────────────────────

SUITES: dict[str, Callable] = {
    "ranking": _ranking.run_suite,
    "songs": _songs.run_suite,
    "context": _ctx.run_suite,
    "synthesis": _synth.run_suite,
}


# ── Reporting ────────────────────────────────────────────────────


@dataclass
class SuiteReport:
    suite: str
    total: int
    passed: int
    failed: int
    skipped: int
    duration_ms: float
    results: list[dict]


def _print_header(suite_name: str) -> None:
    print(f"\n{_c(BOLD, f'── {suite_name.upper()} ──────────────────────────────────────')}")


def _print_result(result) -> None:
    if result.skipped:
        icon = _c(YELLOW, "  SKIP")
        status = _c(DIM, f"score={result.score:.2f}")
    elif result.passed:
        icon = _c(GREEN, "  PASS")
        status = _c(DIM, f"score={result.score:.2f}")
    else:
        icon = _c(RED, "  FAIL")
        status = _c(RED, f"score={result.score:.2f}")

    print(f"{icon}  {result.name:<45} {status}")
    if not result.passed and not result.skipped and result.details:
        print(f"       {_c(DIM, result.details[:120])}")


def _print_suite_summary(report: SuiteReport) -> None:
    parts = []
    if report.passed:
        parts.append(_c(GREEN, f"{report.passed} passed"))
    if report.failed:
        parts.append(_c(RED, f"{report.failed} failed"))
    if report.skipped:
        parts.append(_c(YELLOW, f"{report.skipped} skipped"))
    print(f"       {' · '.join(parts)}  ({report.duration_ms:.0f} ms)\n")


def _print_final_summary(reports: list[SuiteReport], total_ms: float) -> None:
    total = sum(r.total for r in reports)
    passed = sum(r.passed for r in reports)
    failed = sum(r.failed for r in reports)
    skipped = sum(r.skipped for r in reports)

    print(_c(BOLD, "══ SUMMARY ══════════════════════════════════════════"))
    print(
        f"  {_c(GREEN, str(passed))} passed  "
        f"{_c(RED, str(failed))} failed  "
        f"{_c(YELLOW, str(skipped))} skipped  "
        f"of {total} total  ({total_ms:.0f} ms)"
    )
    if failed == 0:
        print(_c(GREEN, "  All evals passed."))
    else:
        print(_c(RED, f"  {failed} eval(s) need attention."))
    print()


# ── Runner ───────────────────────────────────────────────────────


def run_suites(suite_names: list[str]) -> tuple[list[SuiteReport], int]:
    reports: list[SuiteReport] = []
    overall_failed = 0

    for name in suite_names:
        fn = SUITES[name]
        _print_header(name)

        t0 = time.monotonic()
        try:
            results = fn()
        except Exception as exc:
            print(_c(RED, f"  SUITE ERROR: {exc}"))
            import traceback
            traceback.print_exc()
            results = []

        duration_ms = (time.monotonic() - t0) * 1000

        passed = sum(1 for r in results if r.passed and not r.skipped)
        failed = sum(1 for r in results if not r.passed and not r.skipped)
        skipped = sum(1 for r in results if r.skipped)

        for result in results:
            _print_result(result)

        report = SuiteReport(
            suite=name,
            total=len(results),
            passed=passed,
            failed=failed,
            skipped=skipped,
            duration_ms=duration_ms,
            results=[asdict(r) for r in results],
        )
        reports.append(report)
        _print_suite_summary(report)
        overall_failed += failed

    return reports, overall_failed


# ── Entry point ──────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run MusicLife recommendation evals",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--suite",
        default="all",
        help="Comma-separated list of suites to run: ranking,songs,context,synthesis,all",
    )
    parser.add_argument(
        "--json",
        metavar="PATH",
        default=None,
        help="Write full JSON report to this path",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print details for passing evals too",
    )
    args = parser.parse_args()

    suite_arg = args.suite.lower().strip()
    if suite_arg == "all":
        suite_names = list(SUITES.keys())
    else:
        suite_names = [s.strip() for s in suite_arg.split(",")]
        unknown = [s for s in suite_names if s not in SUITES]
        if unknown:
            print(f"Unknown suite(s): {unknown}. Valid: {list(SUITES.keys())}", file=sys.stderr)
            sys.exit(2)

    print(_c(BOLD + ";" + CYAN, "MusicLife Recommendation Evals"))
    print(_c(DIM, f"Suites: {', '.join(suite_names)}"))

    t_start = time.monotonic()
    reports, n_failed = run_suites(suite_names)
    total_ms = (time.monotonic() - t_start) * 1000

    _print_final_summary(reports, total_ms)

    if args.json:
        out = {
            "suites": [asdict(r) for r in reports],
            "summary": {
                "total": sum(r.total for r in reports),
                "passed": sum(r.passed for r in reports),
                "failed": sum(r.failed for r in reports),
                "skipped": sum(r.skipped for r in reports),
                "total_ms": round(total_ms, 1),
            },
        }
        path = Path(args.json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, indent=2))
        print(f"Report written to {path}")

    sys.exit(0 if n_failed == 0 else 1)


if __name__ == "__main__":
    main()

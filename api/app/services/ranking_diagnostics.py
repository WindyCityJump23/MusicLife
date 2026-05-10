"""
Ranking pipeline diagnostics agent.

Runs a suite of checks against the live recommendation pipeline to catch
regressions: duplicate songs, sparse results, lane mismatches, score
anomalies, genre coverage gaps, dedup key collisions, and stale data.

Can be invoked via the /diagnostics/ranking API endpoint or imported
directly for scripting.
"""

from __future__ import annotations

import ast
import inspect
import re
import textwrap
import time
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class Severity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


@dataclass
class Finding:
    check: str
    severity: Severity
    message: str
    detail: str = ""
    auto_fixable: bool = False
    fix_description: str = ""

    def as_dict(self) -> dict:
        d: dict[str, Any] = {
            "check": self.check,
            "severity": self.severity.value,
            "message": self.message,
        }
        if self.detail:
            d["detail"] = self.detail
        if self.auto_fixable:
            d["auto_fixable"] = True
            d["fix_description"] = self.fix_description
        return d


@dataclass
class DiagnosticReport:
    checks_run: int = 0
    passed: int = 0
    findings: list[Finding] = field(default_factory=list)
    duration_ms: float = 0.0
    test_prompts_used: list[str] = field(default_factory=list)

    @property
    def errors(self) -> int:
        return sum(1 for f in self.findings if f.severity == Severity.ERROR)

    @property
    def warnings(self) -> int:
        return sum(1 for f in self.findings if f.severity == Severity.WARNING)

    def as_dict(self) -> dict:
        return {
            "summary": {
                "checks_run": self.checks_run,
                "passed": self.passed,
                "errors": self.errors,
                "warnings": self.warnings,
                "duration_ms": round(self.duration_ms, 1),
            },
            "test_prompts": self.test_prompts_used,
            "findings": [f.as_dict() for f in self.findings],
        }


# ── Test prompts covering different search types ───────────────────
DEFAULT_TEST_PROMPTS = [
    "edm",
    "jazz",
    "sad night drive",
    "indie rock",
    "hip hop",
    None,  # unprompted discover
]

MIN_EXPECTED_RESULTS = 15


# ═══════════════════════════════════════════════════════════════════
#  STATIC CHECKS — analyze song_ranking.py source code
# ═══════════════════════════════════════════════════════════════════

def _check_lane_name_consistency(report: DiagnosticReport) -> None:
    """Verify all lane name strings use the same convention."""
    report.checks_run += 1
    src_path = Path(__file__).parent / "song_ranking.py"
    if not src_path.exists():
        report.findings.append(Finding(
            check="lane_name_consistency",
            severity=Severity.WARNING,
            message="song_ranking.py not found for static analysis",
        ))
        return

    source = src_path.read_text()

    tree = ast.parse(source)
    lane_strings: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            val = node.value
            if val in ("deep_cut", "deep_cuts", "radio_hit", "radio_hits"):
                lane_strings.append((val, node.lineno))

    singular = [(v, ln) for v, ln in lane_strings if v in ("deep_cut", "radio_hit")]
    plural = [(v, ln) for v, ln in lane_strings if v in ("deep_cuts", "radio_hits")]

    if singular and plural:
        report.findings.append(Finding(
            check="lane_name_consistency",
            severity=Severity.ERROR,
            message=f"Mixed lane naming: {len(singular)} singular, {len(plural)} plural references",
            detail=(
                f"Singular (deep_cut/radio_hit): lines {', '.join(str(ln) for _, ln in singular[:10])}\n"
                f"Plural (deep_cuts/radio_hits): lines {', '.join(str(ln) for _, ln in plural[:10])}"
            ),
            auto_fixable=True,
            fix_description="Normalize all lane names to the plural convention matching DISCOVERY_LANES",
        ))
    else:
        report.passed += 1


def _check_duplicate_dict_keys(report: DiagnosticReport) -> None:
    """Detect duplicate keys in dict literals (Python silently drops the first)."""
    report.checks_run += 1
    src_path = Path(__file__).parent / "song_ranking.py"
    if not src_path.exists():
        return

    source = src_path.read_text()
    tree = ast.parse(source)
    duplicates: list[tuple[str, int]] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys_seen: dict[str, int] = {}
            for key in node.keys:
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    if key.value in keys_seen:
                        duplicates.append((key.value, key.lineno))
                    keys_seen[key.value] = key.lineno

    if duplicates:
        report.findings.append(Finding(
            check="duplicate_dict_keys",
            severity=Severity.WARNING,
            message=f"Found {len(duplicates)} duplicate dict key(s) in song_ranking.py",
            detail="; ".join(f'"{k}" at line {ln}' for k, ln in duplicates),
            auto_fixable=True,
            fix_description="Remove the earlier (shadowed) key from each dict literal",
        ))
    else:
        report.passed += 1


def _check_dedup_key_consistency(report: DiagnosticReport) -> None:
    """Verify all dedup/candidate key functions use name-based keys."""
    report.checks_run += 1
    src_path = Path(__file__).parent / "song_ranking.py"
    if not src_path.exists():
        return

    source = src_path.read_text()

    # _candidate_key should NOT prefer spotify_track_id over name
    if re.search(r'def _candidate_key.*?spotify.*?return.*?spotify', source, re.DOTALL):
        report.findings.append(Finding(
            check="dedup_key_consistency",
            severity=Severity.ERROR,
            message="_candidate_key still prefers spotify_track_id — duplicates can survive reranking",
            auto_fixable=True,
            fix_description="Change _candidate_key to always use track_name|artist_name",
        ))
    else:
        report.passed += 1


def _check_dead_reranker(report: DiagnosticReport) -> None:
    """Check if the old _lane_diversity_rerank is still present but uncalled."""
    report.checks_run += 1
    src_path = Path(__file__).parent / "song_ranking.py"
    if not src_path.exists():
        return

    source = src_path.read_text()
    has_def = "def _lane_diversity_rerank" in source
    call_count = source.count("_lane_diversity_rerank(") - (1 if has_def else 0)
    # Subtract the alias assignment
    if "_song_diversity_rerank = _lane_diversity_rerank" in source:
        call_count -= 1

    if has_def and call_count <= 0:
        report.findings.append(Finding(
            check="dead_reranker",
            severity=Severity.INFO,
            message="_lane_diversity_rerank is defined but never called (dead code)",
            auto_fixable=True,
            fix_description="Remove _lane_diversity_rerank and its singular-convention lane references",
        ))
    else:
        report.passed += 1


def _check_genre_synonym_coverage(report: DiagnosticReport) -> None:
    """Ensure every genre phrase that could be ambiguous has synonyms."""
    report.checks_run += 1
    try:
        from app.services.song_ranking import _GENRE_PHRASES, _GENRE_SYNONYMS
    except ImportError:
        return

    abbreviations = {"edm", "dnb", "rnb", "lofi"}
    missing = [g for g in abbreviations & _GENRE_PHRASES if g not in _GENRE_SYNONYMS]
    if missing:
        report.findings.append(Finding(
            check="genre_synonym_coverage",
            severity=Severity.WARNING,
            message=f"Genre abbreviations without synonyms: {missing}",
            detail="Users searching these terms won't match artists tagged with the full genre name",
        ))
    else:
        report.passed += 1


def _check_minimum_results_guard(report: DiagnosticReport) -> None:
    """Verify recommend_songs has a minimum results floor for genre searches."""
    report.checks_run += 1
    src_path = Path(__file__).parent / "song_ranking.py"
    if not src_path.exists():
        return

    source = src_path.read_text()
    has_min = "MIN_RESULTS" in source or "min_results" in source
    has_supplement = "supplementing from full catalog" in source

    if not has_min or not has_supplement:
        report.findings.append(Finding(
            check="minimum_results_guard",
            severity=Severity.ERROR,
            message="No minimum results floor — genre-filtered searches can return very few songs",
            auto_fixable=True,
            fix_description="Add supplemental catalog fill when genre-filtered results < 15",
        ))
    else:
        report.passed += 1


# ═══════════════════════════════════════════════════════════════════
#  RUNTIME CHECKS — execute searches and validate outputs
# ═══════════════════════════════════════════════════════════════════

def _check_duplicates_in_results(
    results: list[dict], prompt: str | None, report: DiagnosticReport
) -> None:
    """Flag any duplicate songs in a result set."""
    report.checks_run += 1
    prompt_label = prompt or "(unprompted)"

    name_keys: Counter[str] = Counter()
    spotify_keys: Counter[str] = Counter()

    for r in results:
        name = (r.get("track_name") or "").strip().lower()
        artist = (r.get("artist_name") or "").strip().lower()
        if name and artist:
            name_keys[f"{name}|{artist}"] += 1

        sid = (r.get("spotify_track_id") or "").strip()
        if sid:
            spotify_keys[sid] += 1

    name_dupes = {k: v for k, v in name_keys.items() if v > 1}
    spotify_dupes = {k: v for k, v in spotify_keys.items() if v > 1}

    if name_dupes or spotify_dupes:
        detail_parts = []
        for key, count in name_dupes.items():
            detail_parts.append(f'"{key}" appears {count}x')
        for key, count in spotify_dupes.items():
            if key not in name_dupes:
                detail_parts.append(f'spotify:{key} appears {count}x')
        report.findings.append(Finding(
            check="duplicate_songs",
            severity=Severity.ERROR,
            message=f"Prompt '{prompt_label}': {len(name_dupes) + len(spotify_dupes)} duplicate song(s)",
            detail="; ".join(detail_parts[:10]),
        ))
    else:
        report.passed += 1


def _check_result_count(
    results: list[dict], prompt: str | None, limit: int, report: DiagnosticReport
) -> None:
    """Ensure results meet the minimum threshold."""
    report.checks_run += 1
    prompt_label = prompt or "(unprompted)"
    count = len(results)

    if count < MIN_EXPECTED_RESULTS:
        report.findings.append(Finding(
            check="result_count",
            severity=Severity.ERROR,
            message=f"Prompt '{prompt_label}': only {count} results (minimum {MIN_EXPECTED_RESULTS})",
        ))
    elif count < limit // 2:
        report.findings.append(Finding(
            check="result_count",
            severity=Severity.WARNING,
            message=f"Prompt '{prompt_label}': only {count}/{limit} results",
        ))
    else:
        report.passed += 1


def _check_score_sanity(
    results: list[dict], prompt: str | None, report: DiagnosticReport
) -> None:
    """Verify scores are non-negative and in a reasonable range."""
    report.checks_run += 1
    prompt_label = prompt or "(unprompted)"

    negative = [r for r in results if (r.get("score") or 0) < 0]
    if negative:
        report.findings.append(Finding(
            check="score_sanity",
            severity=Severity.WARNING,
            message=f"Prompt '{prompt_label}': {len(negative)} result(s) with negative scores",
        ))
        return

    scores = [r.get("score", 0) for r in results]
    if scores:
        max_score = max(scores)
        min_score = min(scores)
        if max_score > 0 and min_score / max_score > 0.98 and len(results) > 5:
            report.findings.append(Finding(
                check="score_sanity",
                severity=Severity.WARNING,
                message=f"Prompt '{prompt_label}': scores have almost no variance ({min_score:.4f}–{max_score:.4f})",
                detail="All results score nearly identically — ranking is effectively random",
            ))
            return

    report.passed += 1


def _check_lane_distribution(
    results: list[dict], prompt: str | None, report: DiagnosticReport
) -> None:
    """Verify results span multiple lanes."""
    report.checks_run += 1
    prompt_label = prompt or "(unprompted)"

    if len(results) < 10:
        report.passed += 1
        return

    lanes = Counter(r.get("lane", "unknown") for r in results)
    if len(lanes) < 2:
        report.findings.append(Finding(
            check="lane_distribution",
            severity=Severity.WARNING,
            message=f"Prompt '{prompt_label}': all {len(results)} results in one lane ({list(lanes.keys())[0]})",
        ))
    else:
        report.passed += 1


def _check_artist_diversity(
    results: list[dict], prompt: str | None, report: DiagnosticReport
) -> None:
    """Flag when too many results come from the same artist."""
    report.checks_run += 1
    prompt_label = prompt or "(unprompted)"

    if len(results) < 5:
        report.passed += 1
        return

    artist_counts = Counter(
        (r.get("artist_name") or "unknown").lower() for r in results
    )
    max_artist, max_count = artist_counts.most_common(1)[0]
    if max_count > 3 and max_count / len(results) > 0.2:
        report.findings.append(Finding(
            check="artist_diversity",
            severity=Severity.WARNING,
            message=f"Prompt '{prompt_label}': '{max_artist}' has {max_count}/{len(results)} results",
            detail="Diversity reranking may not be enforcing artist caps properly",
        ))
    else:
        report.passed += 1


def _check_required_fields(
    results: list[dict], prompt: str | None, report: DiagnosticReport
) -> None:
    """Verify every result has the fields the frontend expects."""
    report.checks_run += 1
    prompt_label = prompt or "(unprompted)"

    required = {
        "track_name", "artist_name", "score", "lane",
        "spotify_track_id", "reasons", "genres",
    }
    missing_report: list[str] = []
    for i, r in enumerate(results[:30]):
        missing = required - set(r.keys())
        if missing:
            missing_report.append(f"result[{i}]: missing {missing}")

    if missing_report:
        report.findings.append(Finding(
            check="required_fields",
            severity=Severity.ERROR,
            message=f"Prompt '{prompt_label}': {len(missing_report)} result(s) missing required fields",
            detail="; ".join(missing_report[:5]),
        ))
    else:
        report.passed += 1


def _check_genre_filter_relevance(
    results: list[dict], prompt: str | None, report: DiagnosticReport
) -> None:
    """When searching a genre, check that results actually match it."""
    report.checks_run += 1

    if not prompt:
        report.passed += 1
        return

    try:
        from app.services.song_ranking import _genre_tokens_for_prompt
    except ImportError:
        report.passed += 1
        return

    tokens = _genre_tokens_for_prompt(prompt)
    if not tokens:
        report.passed += 1
        return

    matching = 0
    for r in results:
        genres = [g.lower() for g in (r.get("genres") or [])]
        genre_text = " ".join(genres)
        if any(t in genre_text for t in tokens):
            matching += 1

    if results and matching / len(results) < 0.3:
        report.findings.append(Finding(
            check="genre_filter_relevance",
            severity=Severity.WARNING,
            message=f"Prompt '{prompt}': only {matching}/{len(results)} results match genre tokens {tokens}",
            detail="Genre filter may not be working, or supplemental results diluted relevance too much",
        ))
    else:
        report.passed += 1


# ═══════════════════════════════════════════════════════════════════
#  AUTO-FIX — apply fixes for known issues
# ═══════════════════════════════════════════════════════════════════

def auto_fix(findings: list[Finding]) -> list[str]:
    """Apply auto-fixes for fixable findings. Returns list of actions taken."""
    actions: list[str] = []
    src_path = Path(__file__).parent / "song_ranking.py"
    if not src_path.exists():
        return actions

    source = src_path.read_text()
    original = source

    fixable = [f for f in findings if f.auto_fixable]
    if not fixable:
        return actions

    for finding in fixable:
        if finding.check == "lane_name_consistency":
            source = source.replace('"deep_cut"', '"deep_cuts"')
            source = source.replace('"radio_hit"', '"radio_hits"')
            actions.append("Normalized lane names to plural convention (deep_cuts, radio_hits)")

        elif finding.check == "duplicate_dict_keys":
            # Remove the first occurrence of duplicate "lane" key in dict literals
            # by finding the pattern: "lane": <expr>,\n...\n"lane": <expr>
            lines = source.split("\n")
            in_dict = False
            first_lane_line = None
            to_remove: list[int] = []
            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped.startswith("{"):
                    in_dict = True
                    first_lane_line = None
                if stripped.startswith("}"):
                    in_dict = False
                    first_lane_line = None
                if in_dict and stripped.startswith('"lane"'):
                    if first_lane_line is not None:
                        to_remove.append(first_lane_line)
                    first_lane_line = i

            if to_remove:
                lines = [line for i, line in enumerate(lines) if i not in to_remove]
                source = "\n".join(lines)
                actions.append(f"Removed {len(to_remove)} duplicate 'lane' dict key(s)")

        elif finding.check == "dedup_key_consistency":
            old = textwrap.dedent("""\
            def _candidate_key(candidate: dict) -> str:
                spotify_id = candidate.get("spotify_track_id")
                if spotify_id:
                    return f"spotify:{spotify_id}"
                return f"{candidate.get('track_name', '')}|{candidate.get('artist_name', '')}".lower()""")
            new = textwrap.dedent("""\
            def _candidate_key(candidate: dict) -> str:
                return f"{(candidate.get('track_name') or '')}|{(candidate.get('artist_name') or '')}".lower()""")
            if old in source:
                source = source.replace(old, new)
                actions.append("Fixed _candidate_key to use name-based dedup consistently")

    if source != original:
        try:
            ast.parse(source)
        except SyntaxError as e:
            return [f"Auto-fix aborted — generated invalid syntax: {e}"]
        src_path.write_text(source)

    return actions


# ═══════════════════════════════════════════════════════════════════
#  MAIN ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

def run_diagnostics(
    client=None,
    user_id: str | None = None,
    prompts: list[str | None] | None = None,
    run_static: bool = True,
    run_runtime: bool = True,
    auto_fix_enabled: bool = False,
    limit: int = 30,
) -> DiagnosticReport:
    """Run the full diagnostic suite.

    Static checks always run (no DB needed). Runtime checks require
    a Supabase client and user_id to actually execute searches.
    """
    report = DiagnosticReport()
    start = time.time()
    prompts = prompts if prompts is not None else DEFAULT_TEST_PROMPTS
    report.test_prompts_used = [p or "(unprompted)" for p in prompts]

    # ── Static checks ──────────────────────────────────────────
    if run_static:
        _check_lane_name_consistency(report)
        _check_duplicate_dict_keys(report)
        _check_dedup_key_consistency(report)
        _check_dead_reranker(report)
        _check_genre_synonym_coverage(report)
        _check_minimum_results_guard(report)

    # ── Runtime checks ─────────────────────────────────────────
    if run_runtime and client and user_id:
        try:
            from app.services.ranking import build_taste_vector
            from app.services.song_ranking import recommend_songs
            from app.services.embedding import embedder
            from app.services.query_intent import interpret_music_prompt

            taste_vector = build_taste_vector(client, user_id)

            for prompt in prompts:
                query_intent = interpret_music_prompt(prompt) if prompt else None
                prompt_for_ranking = query_intent.search_phrase if query_intent else prompt

                prompt_vec = None
                if query_intent:
                    try:
                        embedded = embedder.embed([query_intent.expanded_prompt], input_type="query")
                        prompt_vec = embedded[0] if embedded else None
                    except Exception:
                        pass

                try:
                    results = recommend_songs(
                        client=client,
                        user_id=user_id,
                        taste_vector=taste_vector,
                        prompt_vector=prompt_vec,
                        weights={"affinity": 0.4, "context": 0.4, "editorial": 0.2},
                        exclude_library=False,
                        limit=limit,
                        prompt_text=prompt_for_ranking,
                    )
                except Exception as exc:
                    report.checks_run += 1
                    report.findings.append(Finding(
                        check="runtime_execution",
                        severity=Severity.ERROR,
                        message=f"Prompt '{prompt or '(unprompted)'}' raised {type(exc).__name__}: {exc}",
                    ))
                    continue

                _check_duplicates_in_results(results, prompt, report)
                _check_result_count(results, prompt, limit, report)
                _check_score_sanity(results, prompt, report)
                _check_lane_distribution(results, prompt, report)
                _check_artist_diversity(results, prompt, report)
                _check_required_fields(results, prompt, report)
                _check_genre_filter_relevance(results, prompt, report)

        except ImportError as exc:
            report.findings.append(Finding(
                check="runtime_setup",
                severity=Severity.WARNING,
                message=f"Could not import ranking modules: {exc}",
            ))

    # ── Auto-fix ───────────────────────────────────────────────
    fix_actions: list[str] = []
    if auto_fix_enabled and report.findings:
        fix_actions = auto_fix(report.findings)

    report.duration_ms = (time.time() - start) * 1000

    if fix_actions:
        for action in fix_actions:
            report.findings.append(Finding(
                check="auto_fix",
                severity=Severity.INFO,
                message=f"Applied fix: {action}",
            ))

    return report

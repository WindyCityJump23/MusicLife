"""
Eval: prove that two zero-play saved tracks from different eras do NOT
contribute equally to the taste vector.

A track saved last week should carry ~10× more weight than one saved
3 years ago, even when both have play_count=0 and no last_played_at.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional


def _compute_weight(play_count: int, last_played_at: Optional[str], added_at: Optional[str]) -> float:
    """
    Replicates the weight logic from ranking.py _get_user_artist_weights().
    """
    now = datetime.now(timezone.utc)
    weight = float(play_count if play_count > 0 else 1)

    recency_ts = last_played_at or added_at
    if recency_ts:
        ts = datetime.fromisoformat(recency_ts.replace("Z", "+00:00"))
        days_since = max((now - ts).days, 0)
        weight *= max(0.1, 1.0 - (days_since / 365))

    return weight


def test_recent_save_outweighs_old_save():
    """A track saved 7 days ago should have significantly more weight
    than one saved 3 years ago, both with zero plays."""
    now = datetime.now(timezone.utc)

    recent_added = (now - timedelta(days=7)).isoformat()
    old_added = (now - timedelta(days=3 * 365)).isoformat()

    weight_recent = _compute_weight(play_count=0, last_played_at=None, added_at=recent_added)
    weight_old = _compute_weight(play_count=0, last_played_at=None, added_at=old_added)

    print(f"\nRecent save (7 days ago):   weight = {weight_recent:.4f}")
    print(f"Old save (3 years ago):     weight = {weight_old:.4f}")
    print(f"Ratio (recent/old):         {weight_recent / weight_old:.1f}×")

    # Recent track should be at least 5× more influential
    assert weight_recent > weight_old * 5, (
        f"Expected recent ({weight_recent:.3f}) > 5× old ({weight_old:.3f})"
    )


def test_old_save_gets_floor_weight():
    """A track saved over a year ago should hit the 0.1 floor multiplier."""
    now = datetime.now(timezone.utc)
    old_added = (now - timedelta(days=400)).isoformat()

    weight = _compute_weight(play_count=0, last_played_at=None, added_at=old_added)

    # With play_count=0, base weight=1.0, and 400 days > 365 → floor of 0.1
    assert weight == 0.1, f"Expected floor weight 0.1, got {weight:.4f}"


def test_last_played_takes_priority_over_added():
    """When both timestamps exist, last_played_at should be used."""
    now = datetime.now(timezone.utc)

    # Added long ago, but played recently
    added_at = (now - timedelta(days=1000)).isoformat()
    last_played = (now - timedelta(days=3)).isoformat()

    weight = _compute_weight(play_count=0, last_played_at=last_played, added_at=added_at)

    # Should use last_played (3 days ago) not added_at (1000 days ago)
    # 3 days → decay ≈ 0.992
    assert weight > 0.95, f"Expected ~1.0 (recent play), got {weight:.4f}"


def test_no_timestamps_gets_flat_weight():
    """With no recency data at all, weight should be the base (1.0)."""
    weight = _compute_weight(play_count=0, last_played_at=None, added_at=None)
    assert weight == 1.0, f"Expected flat 1.0, got {weight:.4f}"


if __name__ == "__main__":
    test_recent_save_outweighs_old_save()
    test_old_save_gets_floor_weight()
    test_last_played_takes_priority_over_added()
    test_no_timestamps_gets_flat_weight()
    print("\n✓ All recency weight evals passed.")

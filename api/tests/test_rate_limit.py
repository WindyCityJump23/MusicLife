"""Unit tests for the token-bucket rate limiter."""

import time

import pytest

from app.services.rate_limit import TokenBucketRateLimiter


def test_allows_up_to_capacity_then_blocks():
    limiter = TokenBucketRateLimiter(capacity=3, refill_per_sec=0.001)
    assert [limiter.allow("u") for _ in range(3)] == [True, True, True]
    assert limiter.allow("u") is False


def test_keys_are_isolated():
    limiter = TokenBucketRateLimiter(capacity=1, refill_per_sec=0.001)
    assert limiter.allow("a") is True
    assert limiter.allow("a") is False
    # A different user is unaffected.
    assert limiter.allow("b") is True


def test_refill_restores_tokens_over_time():
    limiter = TokenBucketRateLimiter(capacity=1, refill_per_sec=1000.0)
    assert limiter.allow("u") is True
    assert limiter.allow("u") is False
    time.sleep(0.01)  # 1000/sec refill -> plenty of tokens after 10ms
    assert limiter.allow("u") is True


def test_retry_after_is_positive_when_blocked():
    limiter = TokenBucketRateLimiter(capacity=1, refill_per_sec=0.5)
    assert limiter.allow("u") is True
    assert limiter.allow("u") is False
    assert limiter.retry_after_seconds("u") >= 1


def test_retry_after_zero_when_tokens_available():
    limiter = TokenBucketRateLimiter(capacity=2, refill_per_sec=0.5)
    assert limiter.retry_after_seconds("fresh-key") == 0


def test_invalid_config_rejected():
    with pytest.raises(ValueError):
        TokenBucketRateLimiter(capacity=0, refill_per_sec=1.0)
    with pytest.raises(ValueError):
        TokenBucketRateLimiter(capacity=1, refill_per_sec=0.0)

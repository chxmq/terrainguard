"""Tests for the CFIT-validation statistics helpers (no network)."""

from __future__ import annotations

import numpy as np
from hypothesis import given
from hypothesis.extra import numpy as npst
from hypothesis import strategies as st

from ttci.validation import _auc, _rankdata, _mannwhitney_p


# --- rank data --------------------------------------------------------------

def test_rankdata_distinct():
    np.testing.assert_array_equal(_rankdata(np.array([10.0, 20.0, 30.0])), [1, 2, 3])


def test_rankdata_handles_ties():
    np.testing.assert_array_equal(_rankdata(np.array([10.0, 10.0, 20.0])), [1.5, 1.5, 3])


# --- AUC --------------------------------------------------------------------

def test_auc_perfect_separation():
    assert _auc(np.array([5.0, 6.0, 7.0]), np.array([1.0, 2.0, 3.0])) == 1.0


def test_auc_reverse_separation():
    assert _auc(np.array([1.0, 2.0, 3.0]), np.array([5.0, 6.0, 7.0])) == 0.0


def test_auc_identical_is_half():
    assert _auc(np.array([1.0, 2.0, 3.0]), np.array([1.0, 2.0, 3.0])) == 0.5


_finite = st.floats(min_value=-1e3, max_value=1e3, allow_nan=False, allow_infinity=False)


@given(
    npst.arrays(np.float64, st.integers(2, 30), elements=_finite),
    npst.arrays(np.float64, st.integers(2, 30), elements=_finite),
)
def test_auc_in_unit_range(pos, neg):
    assert 0.0 <= _auc(pos, neg) <= 1.0


# --- Mann-Whitney p ---------------------------------------------------------

@given(
    npst.arrays(np.float64, st.integers(2, 30), elements=_finite),
    npst.arrays(np.float64, st.integers(2, 30), elements=_finite),
)
def test_mannwhitney_p_in_unit_range(pos, neg):
    p = _mannwhitney_p(pos, neg)
    assert 0.0 <= p <= 1.0


def test_mannwhitney_strong_separation_is_significant():
    pos = np.array([100.0, 101.0, 102.0, 103.0, 104.0])
    neg = np.array([0.0, 1.0, 2.0, 3.0, 4.0])
    assert _mannwhitney_p(pos, neg) < 0.05

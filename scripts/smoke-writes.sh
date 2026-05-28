#!/usr/bin/env bash
# Manual smoke pass for the write endpoints. Round-trips one category budget
# (set to current+$1, read back, set back) and one transaction approval flag
# (toggle on, read back, toggle off). Exits non-zero on any mismatch.
#
# Setup:
#   1. Create a dedicated "Claude Connector Test" budget in your YNAB account.
#   2. Add YNAB_TEST_BUDGET_ID to .dev.vars.smoke (gitignored).
#
# Usage:
#   ./scripts/smoke-writes.sh

set -euo pipefail
cd "$(dirname "$0")/.."

YNAB=./scripts/ynab.sh

if [[ -f .dev.vars.smoke ]]; then
  set -a; source .dev.vars.smoke; set +a
fi

[[ -n ${YNAB_TEST_BUDGET_ID:-} ]] || {
  echo "error: YNAB_TEST_BUDGET_ID not set (add it to .dev.vars.smoke)" >&2
  exit 1
}

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*" >&2; exit 1; }

BUD=$YNAB_TEST_BUDGET_ID

echo "==> Reading current month ($BUD)"
month_json=$($YNAB api "/budgets/$BUD/months/current")
month_iso=$(jq -r '.data.month.month' <<<"$month_json")
[[ -n $month_iso && $month_iso != null ]] || fail "could not read current month from $BUD"
pass "current month: $month_iso"

echo "==> Picking a category to round-trip"
cat_id=$(jq -r '.data.month.categories[] | select((.deleted // false) | not) | select((.hidden // false) | not) | select((.internal // false) | not) | .id' <<<"$month_json" | head -1)
[[ -n $cat_id ]] || fail "no editable categories found"
cat_name=$(jq -r --arg id "$cat_id" '.data.month.categories[] | select(.id==$id) | .name' <<<"$month_json")
cat_before=$(jq -r --arg id "$cat_id" '.data.month.categories[] | select(.id==$id) | .budgeted' <<<"$month_json")
pass "category: $cat_name (id $cat_id, budgeted $cat_before)"

target=$(( cat_before + 1000 ))   # +$1.00 in milliunits

echo "==> Setting budgeted to $target"
patch_body=$(jq -n --argjson b "$target" '{category:{budgeted:$b}}')
patched=$($YNAB patch "/budgets/$BUD/months/$month_iso/categories/$cat_id" "$patch_body")
patched_b=$(jq -r '.data.category.budgeted' <<<"$patched")
[[ $patched_b == "$target" ]] || fail "expected budgeted=$target, got $patched_b"
pass "PATCH applied: budgeted=$patched_b"

echo "==> Verifying read-back"
verify=$($YNAB api "/budgets/$BUD/months/$month_iso/categories/$cat_id")
verify_b=$(jq -r '.data.category.budgeted' <<<"$verify")
[[ $verify_b == "$target" ]] || fail "read-back expected $target, got $verify_b"
pass "read-back matches: $verify_b"

echo "==> Restoring original budgeted=$cat_before"
restore_body=$(jq -n --argjson b "$cat_before" '{category:{budgeted:$b}}')
$YNAB patch "/budgets/$BUD/months/$month_iso/categories/$cat_id" "$restore_body" >/dev/null
pass "category restored"

echo "==> Picking a transaction to toggle approval on"
tx_json=$($YNAB api "/budgets/$BUD/transactions?type=unapproved" || echo "")
tx_id=$(jq -r '.data.transactions[0].id // empty' <<<"$tx_json" 2>/dev/null || echo "")
if [[ -z $tx_id ]]; then
  # No unapproved transactions — fall back to any approved one and we'll toggle
  # it off then back on.
  tx_json=$($YNAB api "/budgets/$BUD/transactions")
  tx_id=$(jq -r '.data.transactions[] | select((.deleted // false) | not) | .id' <<<"$tx_json" | head -1)
  start_approved=true
else
  start_approved=false
fi
[[ -n $tx_id ]] || fail "no transactions found to toggle"
pass "transaction: $tx_id (start approved=$start_approved)"

echo "==> Toggling approved=$( [[ $start_approved == true ]] && echo false || echo true )"
new_state=$([[ $start_approved == true ]] && echo false || echo true)
toggle_body=$(jq -n --argjson a "$new_state" '{transaction:{approved:$a}}')
toggled=$($YNAB put "/budgets/$BUD/transactions/$tx_id" "$toggle_body")
toggled_a=$(jq -r '.data.transaction.approved' <<<"$toggled")
[[ $toggled_a == "$new_state" ]] || fail "expected approved=$new_state, got $toggled_a"
pass "PUT applied: approved=$toggled_a"

echo "==> Restoring transaction's original approval=$start_approved"
restore_tx=$(jq -n --argjson a "$start_approved" '{transaction:{approved:$a}}')
$YNAB put "/budgets/$BUD/transactions/$tx_id" "$restore_tx" >/dev/null
pass "transaction restored"

echo
echo "All smoke checks passed."

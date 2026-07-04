/**
 * Session-template diff (tc-gjdx.4) — the safe-direction merge-diff.
 *
 * Computes the would-create subset: template windows whose names are absent
 * from the live session's window-name set.  This is the shared function used
 * by BOTH the dryRun preview path and the real-apply path, so they are
 * guaranteed to agree on the would-create / did-create set (the
 * preview-equals-apply AC).
 *
 * @module template/diff
 */
/**
 * Compute the safe-direction merge-diff: the subset of `template.windows`
 * whose names are absent in `liveWindowNames`.
 *
 * The merge key is the window's `name` field.  A name-matching window (i.e.
 * a template window whose `name` matches an EXISTING live window name) is
 * LEFT ALONE — the idempotent safe direction.
 *
 * Unnamed template windows (`name` omitted): they carry NO merge key, so
 * they can never name-match any live window.  They are therefore always
 * "missing" and are ALWAYS included in the would-create set.  This is the
 * forward-creating interpretation: if you want idempotent skipping, name
 * your windows.
 */
export function templateDiff(template, liveWindowNames) {
    return template.windows.filter((w) => w.name === undefined || !liveWindowNames.has(w.name));
}
//# sourceMappingURL=diff.js.map
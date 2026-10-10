/// Map unchanged characters only when every optimal LCS alignment agrees.
/// Repeated text with ambiguous positions must not supply crop anchors.
pub(crate) fn unchanged_positions(before: &[char], after: &[char]) -> Vec<Option<usize>> {
    if before == after {
        return (0..after.len()).map(Some).collect();
    }
    let mut result = vec![None; after.len()];
    let width = after.len() + 1;
    let Some(cells) = (before.len() + 1).checked_mul(width).filter(|&cells| cells <= 1_000_000) else {
        // Bound work for malformed or exceptionally long OCR lines.
        return result;
    };
    let mut prefix = vec![0u32; cells];
    let mut suffix = vec![0u32; cells];
    for i in 0..before.len() {
        for j in 0..after.len() {
            prefix[(i + 1) * width + j + 1] = if before[i] == after[j] {
                prefix[i * width + j] + 1
            } else {
                prefix[i * width + j + 1].max(prefix[(i + 1) * width + j])
            };
        }
    }
    for i in (0..before.len()).rev() {
        for j in (0..after.len()).rev() {
            suffix[i * width + j] = if before[i] == after[j] {
                suffix[(i + 1) * width + j + 1] + 1
            } else {
                suffix[(i + 1) * width + j].max(suffix[i * width + j + 1])
            };
        }
    }
    let optimum = suffix[0];
    for j in 0..after.len() {
        // If an optimal alignment can omit this character, it may be inserted.
        if (0..=before.len()).any(|i| prefix[i * width + j] + suffix[i * width + j + 1] == optimum) {
            continue;
        }
        let mut positions = (0..before.len()).filter(|&i| {
            before[i] == after[j]
                && prefix[i * width + j] + 1 + suffix[(i + 1) * width + j + 1] == optimum
        });
        if let Some(position) = positions.next() {
            if positions.next().is_none() { result[j] = Some(position); }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::unchanged_positions;

    fn align(before: &str, after: &str) -> Vec<Option<usize>> {
        unchanged_positions(&before.chars().collect::<Vec<_>>(), &after.chars().collect::<Vec<_>>())
    }

    #[test]
    fn recovers_internal_unicode_runs_between_multiple_edits() {
        assert_eq!(align("ašṭbXc", "AšṭbYZC"), vec![None, Some(1), Some(2), Some(3), None, None, None]);
    }

    #[test]
    fn rejects_ambiguous_repeated_positions_and_insertions() {
        assert_eq!(align("AB AB", "AB"), vec![None, None]);
        assert_eq!(align("ab", "aab"), vec![None, None, Some(1)]);
        assert_eq!(align("aba", "aba"), vec![Some(0), Some(1), Some(2)]);
    }

    #[test]
    fn bounds_alignment_work() {
        assert!(unchanged_positions(&vec!['a'; 1000], &vec!['b'; 1000]).iter().all(Option::is_none));
    }
}

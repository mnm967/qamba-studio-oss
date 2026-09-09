//! Carry the app's data directory across a BUNDLE IDENTIFIER rename.
//!
//! WHY THIS IS NOT COSMETIC. `app_data_dir()` is `<platform data root>/<bundle
//! identifier>`, and two things that are expensive-to-impossible to recreate
//! live under it:
//!
//!   * `local/` — every LOCAL PROJECT. Its rows are a file on this machine and
//!     nowhere else; a project that was never pushed to the cloud exists in
//!     that directory or it does not exist.
//!   * `engine/` — the portable ComfyUI: its own CPython, the ComfyUI tree, the
//!     node packs and every model weight the user has downloaded. Gigabytes,
//!     fetched over hours.
//!
//! So renaming `studio.yeuka.desktop` -> `studio.qamba.desktop` without this
//! module is a release where the user opens the app, finds their local projects
//! gone and the engine asking to download itself again — with the old data
//! still on disk under a name nothing looks at, and nothing on screen saying
//! why. This is the same hazard `src/lib/storageMigrate.ts` handles for
//! localStorage, one layer down, and it is handled the same way: sweep every
//! prefix the product has ever used, newest first, and never clobber.
//!
//! IT MOVES, IT DOES NOT COPY. `fs::rename` within one parent directory is
//! atomic and instant whatever the size; copying could mean tens of gigabytes
//! and a half-finished copy on a crash. If the rename fails (a cross-device
//! link, a permission problem) it gives up and says so rather than starting a
//! copy nobody asked for — the old directory is still intact and the user has
//! lost nothing but the automatic carry-over.
//!
//! NOTHING HERE MAY PANIC. It runs in `setup`, before the window exists, so a
//! panic is an app that will not open at all — strictly worse than the
//! migration not happening.
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Every bundle identifier this app has shipped under, NEWEST FIRST. A browser
/// that skipped a release is the case this list exists for: someone still on
/// the Neon build has never had a `studio.yeuka.desktop` directory, and a chain
/// that only knew the most recent rename would leave their work stranded.
const OLD_IDENTIFIERS: &[&str] = &["studio.yeuka.desktop", "studio.neon.desktop"];

/// True when `dir` is absent or holds nothing.
///
/// "Absent" and "empty" are deliberately the same answer: Tauri and its plugins
/// may have created the new directory before `setup` runs, and refusing to
/// migrate into a directory that exists but is empty would make the carry-over
/// depend on plugin initialisation order.
fn vacant(dir: &Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut it) => it.next().is_none(),
        Err(_) => true, // not there, or not readable as a directory
    }
}

/// Which old directory to adopt, given the new one's state and the candidates
/// in priority order. Pure, so the rule is testable without a filesystem.
///
/// Returns `None` when the new directory already holds data — that is real work
/// under the current name, and a migration is never allowed to bury it.
fn choose<'a>(new_vacant: bool, candidates: &'a [(PathBuf, bool)]) -> Option<&'a PathBuf> {
    if !new_vacant {
        return None;
    }
    candidates
        .iter()
        .find(|(_, exists)| *exists)
        .map(|(path, _)| path)
}

/// Move a previous release's data directory onto this one's, once.
///
/// Returns `Some(old_path)` when something was adopted, so the caller can log
/// it — a silent multi-gigabyte move is not something to find out about later.
pub fn migrate(app: &AppHandle) -> Option<PathBuf> {
    let new_dir = app.path().app_data_dir().ok()?;
    let parent = new_dir.parent()?;

    // GUARD: only proceed when the directory's last component really is the
    // bundle identifier. Tauri decides that per platform, and if a future
    // version lays it out differently then `parent.join(old_id)` is a sibling
    // of something else entirely — at best nonexistent, at worst unrelated.
    let current = app.config().identifier.as_str();
    if new_dir.file_name()?.to_str()? != current {
        return None;
    }

    let candidates: Vec<(PathBuf, bool)> = OLD_IDENTIFIERS
        .iter()
        .filter(|id| **id != current)
        .map(|id| {
            let p = parent.join(id);
            let exists = p.is_dir();
            (p, exists)
        })
        .collect();

    let old = choose(vacant(&new_dir), &candidates)?;

    // The new directory may exist and be empty; `rename` onto an existing
    // directory fails on some platforms, so clear it first. Only ever an EMPTY
    // one — `vacant` is what got us here.
    let _ = std::fs::remove_dir(&new_dir);

    match std::fs::rename(old, &new_dir) {
        Ok(()) => Some(old.clone()),
        Err(e) => {
            eprintln!(
                "[datadir] could not adopt {}: {e}. Your projects and engine are \
                 still there — move that directory to {} by hand.",
                old.display(),
                new_dir.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn adopts_the_newest_previous_identifier_that_exists() {
        let c = vec![(p("/d/studio.yeuka.desktop"), true), (p("/d/studio.neon.desktop"), true)];
        assert_eq!(choose(true, &c), Some(&p("/d/studio.yeuka.desktop")));
    }

    #[test]
    fn skips_a_previous_identifier_that_was_never_used() {
        // Someone who last ran the Neon build has no yeuka directory at all;
        // their work is still carried across.
        let c = vec![(p("/d/studio.yeuka.desktop"), false), (p("/d/studio.neon.desktop"), true)];
        assert_eq!(choose(true, &c), Some(&p("/d/studio.neon.desktop")));
    }

    #[test]
    fn never_buries_data_already_under_the_current_name() {
        // The destructive case: a user who has already used the renamed build
        // has real projects there, and adopting over them would lose the work
        // this module exists to protect.
        let c = vec![(p("/d/studio.yeuka.desktop"), true)];
        assert_eq!(choose(false, &c), None);
    }

    #[test]
    fn a_fresh_install_migrates_nothing() {
        let c = vec![(p("/d/studio.yeuka.desktop"), false)];
        assert_eq!(choose(true, &c), None);
    }

    #[test]
    fn vacant_is_true_for_absent_and_for_empty() {
        let tmp = std::env::temp_dir().join(format!("qamba-datadir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(vacant(&tmp), "absent");

        std::fs::create_dir_all(&tmp).unwrap();
        assert!(vacant(&tmp), "empty");

        std::fs::write(tmp.join("local"), b"x").unwrap();
        assert!(!vacant(&tmp), "holds something");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}

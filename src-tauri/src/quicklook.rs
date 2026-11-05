//! Control of the Finder Quick Look extensions in the macOS bundle, through `pluginkit`.
// The pure parts are tested on all platforms; only macOS calls them.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const UTIS: [&str; 2] = ["com.sigmaphoto.photopro-x3f", "com.sigmaphoto.photopro-x3i"];
const POINTS: [&str; 2] = [
    "com.apple.quicklook.thumbnail",
    "com.apple.quicklook.preview",
];
const APPEXES: [&str; 2] = ["X3FThumbnail.appex", "X3FPreview.appex"];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookStatus {
    pub state: &'static str,
    pub conflicts: Vec<Conflict>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub app: String,
    pub ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookSet {
    pub enabled: bool,
    pub ids: Option<Vec<String>>,
}

fn unavailable() -> QuickLookStatus {
    QuickLookStatus {
        state: "unavailable",
        conflicts: vec![],
    }
}

fn our_ids(host: &str) -> [String; 2] {
    [
        format!("{host}.QuickLookThumbnail"),
        format!("{host}.QuickLookPreview"),
    ]
}

/// One line of `pluginkit -m -v`.
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    marker: char,
    id: String,
    path: PathBuf,
}

impl Entry {
    /// `+` use, `!` debugger and a space (default) are enabled. `-`, `?` and `=` are not.
    fn enabled(&self) -> bool {
        matches!(self.marker, '+' | '!' | ' ')
    }

    /// True when this copy is inside `bundle` and not superseded (`=`).
    fn ours(&self, bundle: &Path) -> bool {
        self.marker != '=' && self.path.starts_with(bundle)
    }
}

/// Parse `<marker>    <id>(<version>)\t<uuid>\t<date>\t<path>`. Other lines give `None`.
fn parse(line: &str) -> Option<Entry> {
    let marker = line.chars().next()?;
    if !"+-!=? ".contains(marker) {
        return None;
    }
    let mut fields = line[1..].trim_start().split('\t');
    let name = fields.next()?;
    let path = fields.nth(2)?;
    let id = name.rsplit_once('(').map_or(name, |(id, _)| id);
    (!id.is_empty() && !id.contains(' ') && path.starts_with('/')).then(|| Entry {
        marker,
        id: id.into(),
        path: path.into(),
    })
}

/// The state from the selected copies of our two extensions.
fn state(bundle: &Path, ours: &[Option<Entry>]) -> &'static str {
    if !all_ours(bundle, ours) {
        "unavailable"
    } else if ours.iter().flatten().all(Entry::enabled) {
        "on"
    } else {
        "off"
    }
}

/// True when every selected copy exists and belongs to `bundle`.
fn all_ours(bundle: &Path, selected: &[Option<Entry>]) -> bool {
    selected
        .iter()
        .all(|e| e.as_ref().is_some_and(|e| e.ours(bundle)))
}

/// True when an extension's Info.plist (as JSON) is a Quick Look extension for X3F or X3I.
fn handles(plist: &Value) -> bool {
    let extension = &plist["NSExtension"];
    let point = extension["NSExtensionPointIdentifier"].as_str();
    let types = extension["NSExtensionAttributes"]["QLSupportedContentTypes"].as_array();
    point.is_some_and(|point| POINTS.contains(&point))
        && types.is_some_and(|types| types.iter().any(|t| UTIS.iter().any(|u| t == u)))
}

/// Other enabled extensions that `handles` accepts, grouped by containing app.
fn conflicts(
    entries: impl IntoIterator<Item = Entry>,
    ours: &[String],
    handles: impl Fn(&Path) -> bool,
) -> Vec<Conflict> {
    let mut found: Vec<(PathBuf, Conflict)> = vec![];
    for entry in entries {
        if !entry.enabled() || ours.contains(&entry.id) || !handles(&entry.path) {
            continue;
        }
        // Group by the full app path: two apps can have the same folder name.
        let path = entry
            .path
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .unwrap_or(&entry.path)
            .to_path_buf();
        match found.iter_mut().find(|(p, _)| *p == path) {
            Some((_, c)) if c.ids.contains(&entry.id) => {}
            Some((_, c)) => c.ids.push(entry.id),
            None => {
                let app = path
                    .file_stem()
                    .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
                found.push((
                    path,
                    Conflict {
                        app,
                        ids: vec![entry.id],
                    },
                ));
            }
        }
    }
    found.into_iter().map(|(_, c)| c).collect()
}

/// Accept only IDs that are current conflicts.
fn check(status: &QuickLookStatus, ids: &[String]) -> Result<(), String> {
    match ids
        .iter()
        .find(|id| !status.conflicts.iter().any(|c| c.ids.contains(id)))
    {
        Some(id) => Err(format!("Not a conflicting Quick Look extension: {id}")),
        None => Ok(()),
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::process::Command;

    fn run(program: &str, args: &[&str]) -> Result<String, String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|e| format!("{program}: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "{program} {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn pluginkit(args: &[&str]) -> Result<String, String> {
        run("/usr/bin/pluginkit", args)
    }

    /// The running `.app` and its two extensions, or `None` without them.
    fn bundle() -> Option<(PathBuf, [PathBuf; 2])> {
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        let contents = exe.parent()?.parent()?;
        let app = contents.parent()?;
        if exe.parent()?.file_name()? != "MacOS"
            || contents.file_name()? != "Contents"
            || app.extension()? != "app"
        {
            return None;
        }
        let appexes = APPEXES.map(|name| contents.join("PlugIns").join(name));
        appexes
            .iter()
            .all(|p| p.is_dir())
            .then(|| (app.to_path_buf(), appexes))
    }

    /// The copy that macOS uses for `id`.
    fn selected(id: &str) -> Option<Entry> {
        pluginkit(&["-m", "-v", "-i", id])
            .ok()?
            .lines()
            .filter_map(parse)
            .find(|e| e.id == id)
    }

    fn plist_handles(appex: &Path) -> bool {
        let plist = appex.join("Contents/Info.plist");
        // Binary and XML plists keep ASCII strings as is, so a byte search skips
        // most extensions without a plutil process.
        let Ok(bytes) = std::fs::read(&plist) else {
            return false;
        };
        let has = |s: &str| bytes.windows(s.len()).any(|w| w == s.as_bytes());
        if !UTIS.iter().any(|u| has(u)) {
            return false;
        }
        let Some(plist) = plist.to_str() else {
            return false;
        };
        run("/usr/bin/plutil", &["-convert", "json", "-o", "-", plist])
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .is_some_and(|json| handles(&json))
    }

    pub fn status(host: &str) -> QuickLookStatus {
        let Some((app, _)) = bundle() else {
            return unavailable();
        };
        let ids = our_ids(host);
        let state = state(&app, &ids.clone().map(|id| selected(&id)));
        if state != "on" {
            return QuickLookStatus {
                state,
                conflicts: vec![],
            };
        }
        // `pluginkit -p com.apple.quicklook.thumbnail` lists nothing on macOS 27, so
        // list all selected copies and read each extension point from its plist.
        let entries = pluginkit(&["-m", "-v"]).unwrap_or_default();
        QuickLookStatus {
            state,
            conflicts: conflicts(entries.lines().filter_map(parse), &ids, plist_handles),
        }
    }

    pub fn set(host: &str, payload: QuickLookSet) -> Result<QuickLookStatus, String> {
        let current = status(host);
        let (election, ids) = match payload.ids {
            Some(ids) => {
                check(&current, &ids)?;
                ("ignore", ids)
            }
            // Do not change another copy, for example the installed app under `tauri dev`.
            None if current.state == "unavailable" => return Ok(current),
            None => (
                if payload.enabled { "use" } else { "ignore" },
                our_ids(host).to_vec(),
            ),
        };
        for id in &ids {
            pluginkit(&["-e", election, "-i", id])?;
        }
        let _ = run("/usr/bin/qlmanage", &["-r"]);
        let _ = run("/usr/bin/qlmanage", &["-r", "cache"]);
        Ok(status(host))
    }

    /// Repair the registration, then elect `use` once. Returns true after the election.
    pub fn register(host: &str, elected: bool) -> Result<bool, String> {
        let Some((app, appexes)) = bundle() else {
            return Ok(false);
        };
        if app.to_string_lossy().contains("/AppTranslocation/") {
            return Ok(false);
        }
        let ids = our_ids(host);
        let copies = || ids.clone().map(|id| selected(&id));
        let mut ours = all_ours(&app, &copies());
        if !ours {
            for appex in &appexes {
                pluginkit(&["-a", &appex.to_string_lossy()])?;
            }
            ours = all_ours(&app, &copies());
        }
        if elected {
            return Ok(false);
        }
        // Do not elect another copy, and try again on the next launch.
        if !ours {
            return Err(
                "another copy is selected after the repair; first-launch election skipped".into(),
            );
        }
        for id in &ids {
            pluginkit(&["-e", "use", "-i", id])?;
        }
        Ok(true)
    }
}

pub fn status(host: &str) -> QuickLookStatus {
    #[cfg(target_os = "macos")]
    return mac::status(host);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = host;
        unavailable()
    }
}

pub fn set(host: &str, payload: QuickLookSet) -> Result<QuickLookStatus, String> {
    #[cfg(target_os = "macos")]
    return mac::set(host, payload);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (host, payload);
        Ok(unavailable())
    }
}

/// Repair the extension registration and do the first-launch election on a thread.
/// Failures go to the log; startup continues.
pub fn startup(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use std::sync::Arc;
        use tauri::{Emitter, Manager};
        let app = app.clone();
        std::thread::spawn(move || {
            let state = app.state::<Arc<crate::AppState>>();
            let elected = state.preferences.get().quick_look_registered;
            let result = mac::register(&app.config().identifier, elected).and_then(|done| {
                if done {
                    state
                        .preferences
                        .set(serde_json::json!({ "quickLookRegistered": true }))?;
                    let _ = app.emit("settings:changed", ());
                }
                Ok(())
            });
            if let Err(error) = result {
                state.logs.write("error", format!("Quick Look: {error}"));
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(marker: char, id: &str, path: &str) -> String {
        format!("{marker}    {id}(0.2.0)\tBE039620-F920-570C-B15C-9A632729305D\t2026-11-05 18:41:58 +0000\t{path}")
    }

    #[test]
    fn quicklook_rules() {
        let app = Path::new("/Applications/X3Fuse.app");
        let ids = our_ids("com.sagwa.X3Fuse");
        let ours = |marker| {
            parse(&line(
                marker,
                &ids[0],
                "/Applications/X3Fuse.app/Contents/PlugIns/X3FThumbnail.appex",
            ))
        };
        for (marker, expected) in [
            ('+', "on"),
            ('!', "on"),
            (' ', "on"),
            ('?', "off"),
            ('-', "off"),
            ('=', "unavailable"),
        ] {
            assert_eq!(
                state(app, &[ours(marker), ours('+')]),
                expected,
                "{marker:?}"
            );
        }
        let foreign = parse(&line(
            '+',
            &ids[1],
            "/Applications/X3Fuse Alpha.app/Contents/PlugIns/X3FPreview.appex",
        ));
        assert_eq!(state(app, &[ours('+'), foreign.clone()]), "unavailable");
        assert_eq!(state(app, &[ours('+'), None]), "unavailable");
        // The election needs both copies ours after the repair: a repair that leaves
        // the foreign copy selected, or a superseded copy, blocks it.
        assert!(!all_ours(app, &[ours('+'), foreign]));
        assert!(!all_ours(app, &[ours('='), ours('+')]));
        assert!(all_ours(app, &[ours('-'), ours(' ')]));

        for bad in [
            "",
            " (21 plug-ins)",
            "  (no matches)",
            "*    a.b(1)\tu\td\t/p",
            "+    a.b(1)\tu",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }

        let peek = "/Applications/X3F Peek.app/Contents/PlugIns/Preview.appex";
        let peek_thumb = "/Applications/X3F Peek.app/Contents/PlugIns/Thumb.appex";
        let other = "/Applications/Other.app/Contents/PlugIns/Preview.appex";
        let entries = [
            line('+', "peek.preview", peek),
            line(' ', "peek.thumbnail", peek_thumb),
            line('-', "peek.off", peek),
            line('?', "peek.unknown", peek),
            line('=', "peek.superseded", peek),
            line('+', "other.preview", other),
            line('+', &ids[0], peek),
        ];
        // Two different apps with the same folder name stay separate.
        let twin = "/Users/me/X3F Peek.app/Contents/PlugIns/Preview.appex";
        let twins = conflicts(
            [
                line('+', "peek.preview", peek),
                line('+', "twin.preview", twin),
            ]
            .iter()
            .filter_map(|l| parse(l)),
            &ids,
            |_| true,
        );
        assert_eq!(twins.len(), 2);
        assert!(twins
            .iter()
            .all(|c| c.app == "X3F Peek" && c.ids.len() == 1));

        let found = conflicts(entries.iter().filter_map(|l| parse(l)), &ids, |p| {
            p.starts_with("/Applications/X3F Peek.app")
        });
        assert_eq!(
            found,
            vec![Conflict {
                app: "X3F Peek".into(),
                ids: vec!["peek.preview".into(), "peek.thumbnail".into()],
            }]
        );

        let plist = |point: &str, types: Value| {
            serde_json::json!({ "NSExtension": {
                "NSExtensionPointIdentifier": point,
                "NSExtensionAttributes": { "QLSupportedContentTypes": types },
            }})
        };
        assert!(handles(&plist(POINTS[0], serde_json::json!([UTIS[1]]))));
        assert!(!handles(&plist(
            POINTS[1],
            serde_json::json!(["public.jpeg"])
        )));
        assert!(!handles(&plist(
            "com.apple.share-services",
            serde_json::json!([UTIS[0]])
        )));

        let status = QuickLookStatus {
            state: "on",
            conflicts: found,
        };
        assert!(check(&status, &["peek.thumbnail".into()]).is_ok());
        assert!(check(&status, &["peek.preview".into(), ids[1].clone()]).is_err());
        assert_eq!(
            serde_json::to_value(&status).unwrap()["conflicts"][0]["ids"][1],
            "peek.thumbnail"
        );
    }
}

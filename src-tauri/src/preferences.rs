use serde::{Deserialize, Deserializer, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocalePreference {
    Auto,
    En,
    Ja,
    #[serde(rename = "zh-Hans")]
    ZhHans,
    #[serde(rename = "zh-Hant")]
    ZhHant,
}

impl Default for LocalePreference {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SupportedLocale {
    En,
    Ja,
    #[serde(rename = "zh-Hans")]
    ZhHans,
    #[serde(rename = "zh-Hant")]
    ZhHant,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct UserPreferences {
    pub version: u8,
    pub language: LocalePreference,
    #[serde(rename = "osLocale")]
    pub os_locale: Option<String>,
    #[serde(rename = "lastProject")]
    pub last_project: Option<LastOpenedProject>,
    #[serde(rename = "imageMagnifierEnabled")]
    pub image_magnifier_enabled: bool,
    #[serde(rename = "textMagnifierEnabled")]
    pub text_magnifier_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LastOpenedProject {
    pub path: String,
    #[serde(rename = "pageId")]
    pub page_id: String,
}

impl UserPreferences {
    pub fn default_with_os(os_locale: Option<String>) -> Self {
        Self {
            version: 1,
            language: LocalePreference::Auto,
            os_locale,
            last_project: None,
            image_magnifier_enabled: true,
            text_magnifier_enabled: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct StoredPreferences {
    version: Option<u8>,
    language: Option<LocalePreference>,
    #[serde(
        default,
        rename = "lastProject",
        deserialize_with = "deserialize_last_opened_project"
    )]
    last_project: Option<LastOpenedProject>,
    #[serde(default = "default_true", rename = "imageMagnifierEnabled")]
    image_magnifier_enabled: bool,
    #[serde(default = "default_true", rename = "textMagnifierEnabled")]
    text_magnifier_enabled: bool,
}

fn default_true() -> bool {
    true
}

fn deserialize_last_opened_project<'de, D>(
    deserializer: D,
) -> Result<Option<LastOpenedProject>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

pub fn preferences_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn read_preferences(config_dir: &Path, os_locale: Option<String>) -> UserPreferences {
    let path = preferences_path(config_dir);
    let Ok(raw) = fs::read_to_string(path) else {
        return UserPreferences::default_with_os(os_locale);
    };
    let Ok(stored) = serde_json::from_str::<StoredPreferences>(&raw) else {
        return UserPreferences::default_with_os(os_locale);
    };
    if stored.version.unwrap_or(0) != 1 {
        return UserPreferences::default_with_os(os_locale);
    }
    UserPreferences {
        version: 1,
        language: stored.language.unwrap_or_default(),
        os_locale,
        last_project: stored.last_project,
        image_magnifier_enabled: stored.image_magnifier_enabled,
        text_magnifier_enabled: stored.text_magnifier_enabled,
    }
}

pub fn write_preferences(config_dir: &Path, preferences: &UserPreferences) -> Result<(), String> {
    fs::create_dir_all(config_dir)
        .map_err(|e| format!("could not create preferences directory: {e}"))?;
    let target = preferences_path(config_dir);
    let mut temp = tempfile::NamedTempFile::new_in(config_dir)
        .map_err(|e| format!("could not create preferences temp file: {e}"))?;
    let body = serde_json::json!({
        "version": 1,
        "language": preferences.language,
        "lastProject": preferences.last_project,
        "imageMagnifierEnabled": preferences.image_magnifier_enabled,
        "textMagnifierEnabled": preferences.text_magnifier_enabled,
    });
    temp.write_all(
        serde_json::to_string_pretty(&body)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| format!("could not write preferences: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("could not flush preferences: {e}"))?;

    temp.persist(&target)
        .map_err(|e| format!("could not replace preferences: {}", e.error))?;
    Ok(())
}

pub fn resolve_locale(preference: &LocalePreference, os_locale: Option<&str>) -> SupportedLocale {
    match preference {
        LocalePreference::En => SupportedLocale::En,
        LocalePreference::Ja => SupportedLocale::Ja,
        LocalePreference::ZhHans => SupportedLocale::ZhHans,
        LocalePreference::ZhHant => SupportedLocale::ZhHant,
        LocalePreference::Auto => {
            let value = os_locale
                .unwrap_or("")
                .trim()
                .replace('_', "-")
                .to_ascii_lowercase();
            let parts: Vec<&str> = value.split('-').collect();
            if parts.first() == Some(&"zh") && parts.iter().any(|part| *part == "hans") {
                SupportedLocale::ZhHans
            } else if parts.first() == Some(&"zh") && parts.iter().any(|part| *part == "hant") {
                SupportedLocale::ZhHant
            } else if parts.first() == Some(&"zh")
                && parts.iter().any(|part| matches!(*part, "cn" | "sg"))
            {
                SupportedLocale::ZhHans
            } else if parts.first() == Some(&"zh")
                && parts.iter().any(|part| matches!(*part, "tw" | "hk" | "mo"))
            {
                SupportedLocale::ZhHant
            } else if parts.first() == Some(&"zh") {
                SupportedLocale::ZhHans
            } else if parts.first() == Some(&"ja") {
                SupportedLocale::Ja
            } else {
                SupportedLocale::En
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolves_script_and_region_priority() {
        assert_eq!(
            resolve_locale(&LocalePreference::Auto, Some("zh-Hant-CN")),
            SupportedLocale::ZhHant
        );
        assert_eq!(
            resolve_locale(&LocalePreference::Auto, Some("zh-CN")),
            SupportedLocale::ZhHans
        );
        assert_eq!(
            resolve_locale(&LocalePreference::Auto, Some("zh_TW")),
            SupportedLocale::ZhHant
        );
        assert_eq!(
            resolve_locale(&LocalePreference::Auto, Some("ja-JP")),
            SupportedLocale::Ja
        );
        assert_eq!(
            resolve_locale(&LocalePreference::Auto, Some("fr-FR")),
            SupportedLocale::En
        );
    }

    #[test]
    fn round_trips_and_recovers_corrupt_preferences() {
        let dir = tempdir().unwrap();
        let preferences = UserPreferences {
            version: 1,
            language: LocalePreference::ZhHant,
            os_locale: None,
            last_project: Some(LastOpenedProject {
                path: "C:/books/reading.eduba".into(),
                page_id: "page-2".into(),
            }),
            image_magnifier_enabled: false,
            text_magnifier_enabled: true,
        };
        write_preferences(dir.path(), &preferences).unwrap();
        assert_eq!(
            read_preferences(dir.path(), Some("ja-JP".into())).language,
            LocalePreference::ZhHant
        );
        let restored = read_preferences(dir.path(), None);
        assert_eq!(restored.last_project, preferences.last_project);
        assert!(!restored.image_magnifier_enabled);
        assert!(restored.text_magnifier_enabled);
        fs::write(preferences_path(dir.path()), b"{not-json").unwrap();
        let recovered = read_preferences(dir.path(), Some("ja-JP".into()));
        assert_eq!(recovered.language, LocalePreference::Auto);
        assert_eq!(recovered.os_locale.as_deref(), Some("ja-JP"));
    }
    #[test]
    fn missing_and_invalid_preferences_default_to_auto() {
        let dir = tempdir().unwrap();
        let missing = read_preferences(dir.path(), Some("en-US".into()));
        assert_eq!(missing.language, LocalePreference::Auto);
        assert!(missing.image_magnifier_enabled);
        assert!(missing.text_magnifier_enabled);
        fs::write(
            preferences_path(dir.path()),
            r#"{"version":1,"language":"pirate"}"#,
        )
        .unwrap();
        assert_eq!(
            read_preferences(dir.path(), None).language,
            LocalePreference::Auto
        );
    }

    #[test]
    fn legacy_preferences_default_magnifiers_to_enabled() {
        let dir = tempdir().unwrap();
        fs::write(
            preferences_path(dir.path()),
            r#"{"version":1,"language":"ja","lastProject":{"path":"book.eduba","pageId":"p1"}}"#,
        )
        .unwrap();
        let migrated = read_preferences(dir.path(), None);
        assert!(migrated.image_magnifier_enabled);
        assert!(migrated.text_magnifier_enabled);
        assert_eq!(migrated.language, LocalePreference::Ja);
        assert!(migrated.last_project.is_some());
    }

    #[test]
    fn ignores_invalid_last_project_without_discarding_language() {
        let dir = tempdir().unwrap();
        fs::write(
            preferences_path(dir.path()),
            r#"{"version":1,"language":"ja","lastProject":{"path":42}}"#,
        )
        .unwrap();
        let preferences = read_preferences(dir.path(), None);
        assert_eq!(preferences.language, LocalePreference::Ja);
        assert_eq!(preferences.last_project, None);
    }

    #[test]
    fn repeated_save_replaces_existing_file_and_reports_write_failure() {
        let dir = tempdir().unwrap();
        let mut preferences = UserPreferences::default_with_os(None);
        preferences.language = LocalePreference::En;
        write_preferences(dir.path(), &preferences).unwrap();
        preferences.language = LocalePreference::Ja;
        write_preferences(dir.path(), &preferences).unwrap();
        assert_eq!(
            read_preferences(dir.path(), None).language,
            LocalePreference::Ja
        );
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, b"file").unwrap();
        assert!(write_preferences(&blocked, &preferences).is_err());
    }
}

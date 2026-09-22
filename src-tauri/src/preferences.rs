use serde::{Deserialize, Serialize};
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
}

impl UserPreferences {
    pub fn default_with_os(os_locale: Option<String>) -> Self {
        Self {
            version: 1,
            language: LocalePreference::Auto,
            os_locale,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct StoredPreferences {
    version: Option<u8>,
    language: Option<LocalePreference>,
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
    }
}

pub fn write_preferences(config_dir: &Path, language: LocalePreference) -> Result<(), String> {
    fs::create_dir_all(config_dir)
        .map_err(|e| format!("could not create preferences directory: {e}"))?;
    let target = preferences_path(config_dir);
    let mut temp = tempfile::NamedTempFile::new_in(config_dir)
        .map_err(|e| format!("could not create preferences temp file: {e}"))?;
    let body = serde_json::json!({ "version": 1, "language": language });
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
        write_preferences(dir.path(), LocalePreference::ZhHant).unwrap();
        assert_eq!(
            read_preferences(dir.path(), Some("ja-JP".into())).language,
            LocalePreference::ZhHant
        );
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
    fn repeated_save_replaces_existing_file_and_reports_write_failure() {
        let dir = tempdir().unwrap();
        write_preferences(dir.path(), LocalePreference::En).unwrap();
        write_preferences(dir.path(), LocalePreference::Ja).unwrap();
        assert_eq!(
            read_preferences(dir.path(), None).language,
            LocalePreference::Ja
        );
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, b"file").unwrap();
        assert!(write_preferences(&blocked, LocalePreference::En).is_err());
    }
}

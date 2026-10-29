import { useTranslation } from "react-i18next";

const familyLinks = [
  { name: "Blog", href: "https://blog.kurnugia.com/" },
  { name: "KUR.NU.GI₄.A", href: "https://app.kurnugia.com/" },
  { name: "qantuppi", href: "https://qantuppi.kurnugia.com/" },
  { name: "Ḫubur", href: "https://hubur.kurnugia.com/" },
  { name: "Nisaba-zami", href: "https://nisaba-zami.kurnugia.com/" },
];

export function KurnugiaLinks() {
  const { t } = useTranslation();
  return (
    <nav className="family-links" aria-label={t("browser.familyLinks")}>
      {familyLinks.map(({ name, href }) => (
        <a key={href} href={href} target="_blank" rel="noopener noreferrer" title={t("browser.openInNewTab")}>
          {name}
        </a>
      ))}
    </nav>
  );
}

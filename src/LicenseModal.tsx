import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import picodetLicense from "../src-tauri/resources/figure-detection/LICENSE?raw";
import picodetNotice from "../src-tauri/resources/figure-detection/MODEL-NOTICE.txt?raw";
import fontLicense from "./assets/fonts/NotoSerif-OFL.txt?raw";

/** Show the same license texts that ship with the model and fonts, fully offline. */
export function LicenseModal({ back, close }: { back: () => void; close: () => void }) {
  const { t } = useTranslation();
  return <div className="modal-scrim">
    <div className="modal license-modal" role="dialog" aria-modal="true" aria-labelledby="license-title">
      <div className="modal-head">
        <h2 id="license-title">{t("ui.licenses")}</h2>
        <button className="icon-btn" onClick={close} aria-label={t("ui.close")}><X size={16} /></button>
      </div>
      <div className="license-content">
        <details open>
          <summary>PicoDet-S_layout_3cls — Apache License 2.0</summary>
          <pre>{picodetNotice}</pre>
          <pre>{picodetLicense}</pre>
        </details>
        <details>
          <summary>Noto Serif — SIL Open Font License 1.1</summary>
          <pre>{fontLicense}</pre>
        </details>
      </div>
      <div className="modal-actions"><button onClick={back}>{t("ui.back")}</button><button className="primary" onClick={close}>{t("ui.close")}</button></div>
    </div>
  </div>;
}

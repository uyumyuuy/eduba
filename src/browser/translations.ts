const baseBrowserResources = {
  en: { save: "Save project", saveAs: "Save as…", recover: "Working projects", recoveryTitle: "Open a working project", recoveryDescription: "Your work is saved automatically in this browser. To keep important work, use “Save project” to also save a .eduba file on your device.", recoveryEmpty: "No working projects are saved in this browser.", localOnly: "All work, including reading PDFs and OCR, is processed on your device, so your data is never sent to a server.", unsavedFile: "Save changes to the project file", savedFile: "Project file saved", workingSaved: "Working copy saved in this browser." },
  ja: { save: "プロジェクトを保存", saveAs: "名前を付けて保存…", recover: "作業中のプロジェクト", recoveryTitle: "作業中のプロジェクトを開く", recoveryDescription: "作業内容はこのブラウザに自動保存されています。大切な作業は「プロジェクトを保存」から、.eduba ファイルとして端末にも保存してください。", recoveryEmpty: "このブラウザに保存したプロジェクトはありません。", localOnly: "PDFの読み取りとOCRを含めすべての作業は端末内で処理されるため、サーバにデータが送られることはありません", unsavedFile: "ファイルへの保存が必要です", savedFile: "プロジェクトファイル保存済み", workingSaved: "作業内容をこのブラウザに保存しました。" },
  "zh-Hans": { save: "保存项目", saveAs: "另存为…", recover: "工作中的项目", recoveryTitle: "打开工作中的项目", recoveryDescription: "工作内容会自动保存在此浏览器中。对于重要的工作，请通过“保存项目”将 .eduba 文件同时保存到设备上。", recoveryEmpty: "此浏览器中没有保存的项目。", localOnly: "包括 PDF 读取和 OCR 在内的所有工作均在您的设备上处理，数据不会发送到服务器。", unsavedFile: "需要保存项目文件", savedFile: "项目文件已保存", workingSaved: "工作副本已保存在此浏览器中。" },
  "zh-Hant": { save: "儲存專案", saveAs: "另存新檔…", recover: "工作中的專案", recoveryTitle: "開啟工作中的專案", recoveryDescription: "工作內容會自動儲存在此瀏覽器中。對於重要的工作，請透過「儲存專案」將 .eduba 檔案同時儲存至裝置上。", recoveryEmpty: "此瀏覽器中沒有儲存的專案。", localOnly: "包括 PDF 讀取和 OCR 在內的所有工作均在您的裝置上處理，資料不會傳送至伺服器。", unsavedFile: "需要儲存專案檔案", savedFile: "專案檔案已儲存", workingSaved: "工作副本已儲存在此瀏覽器中。" },
} as const;

const workingProjectResources = {
  en: {
    familyLinks: "Kurnugia family",
    help: "Help",
    openInNewTab: "Opens in a new tab",
    resetModel: "Use the baseline model",
    storageProtection: {
      enabled: { title: "Stored data protection: Enabled", description: "Your work is protected from automatic deletion due to low storage space. However, clearing site data in your browser settings or elsewhere will also delete your work." },
      disabled: { title: "Stored data protection: Disabled", description: "Your work may be deleted automatically due to low storage space or your browser’s storage policy." },
      unknown: { title: "Stored data protection: Cannot be checked", description: "This environment cannot confirm whether your work is protected from automatic deletion." },
    },
    privateBrowsingNotice: "In private browsing, your work may be deleted when the private session ends.",
    pageCount: "Logical pages", dataSize: "Data size", lastEdited: "Last edited", unknown: "Unknown", currentProject: "Current project",
    deleteWorking: "Delete", deletingWorking: "Deleting…", deleteWorkingLabel: "Delete {{name}} from this browser",
    deleteWorkingConfirm: "Delete “{{name}}” from this browser?\n\nIts working PDF, OCR results, corrections, and undo history will be removed permanently. Save a .eduba file first if you need a backup.\n\nFiles already saved on your device are kept. The project will close if it is currently open.",
    workingDeleted: "Deleted “{{name}}” from this browser.", workingDeleteFailed: "Could not delete the working project: {{error}}",
  },
  ja: {
    familyLinks: "Kurnugiaファミリー",
    help: "ヘルプ",
    openInNewTab: "新しいタブで開きます",
    resetModel: "基準モデルに戻す",
    storageProtection: {
      enabled: { title: "保存データの保護：有効", description: "容量不足による自動削除から保護されています。ただし、ブラウザの設定などでサイトデータを削除すると、作業内容も削除されます。" },
      disabled: { title: "保存データの保護：無効", description: "容量不足やブラウザの保存方針により、作業内容が自動的に削除される場合があります。" },
      unknown: { title: "保存データの保護：確認できません", description: "この環境では、自動削除から保護されているか確認できません。" },
    },
    privateBrowsingNotice: "プライベートブラウズでは、終了時に作業内容が削除される場合があります。",
    pageCount: "論理ページ数", dataSize: "データ容量", lastEdited: "最終編集日時", unknown: "不明", currentProject: "現在のプロジェクト",
    deleteWorking: "削除", deletingWorking: "削除中…", deleteWorkingLabel: "{{name}} をこのブラウザから削除",
    deleteWorkingConfirm: "「{{name}}」をこのブラウザから削除しますか？\n\nこの作業コピーの PDF・OCR 結果・校正内容・取り消し履歴が削除され、元に戻せません。必要な内容は先に .eduba ファイルとして保存してください。\n\n端末に保存済みのファイルは残ります。現在開いている場合はプロジェクトを閉じます。",
    workingDeleted: "「{{name}}」をこのブラウザから削除しました。", workingDeleteFailed: "作業コピーを削除できませんでした：{{error}}",
  },
  "zh-Hans": {
    familyLinks: "Kurnugia 系列",
    help: "帮助",
    openInNewTab: "在新标签页中打开",
    resetModel: "恢复基准模型",
    storageProtection: {
      enabled: { title: "存储数据保护：已启用", description: "工作内容已受到保护，不会因存储空间不足而被自动删除。但是，在浏览器设置等位置清除网站数据时，工作内容也会被删除。" },
      disabled: { title: "存储数据保护：未启用", description: "工作内容可能因存储空间不足或浏览器的存储策略而被自动删除。" },
      unknown: { title: "存储数据保护：无法确认", description: "在此环境中，无法确认工作内容是否受到自动删除保护。" },
    },
    privateBrowsingNotice: "在隐私浏览模式下，工作内容可能在隐私会话结束时被删除。",
    pageCount: "逻辑页数", dataSize: "数据大小", lastEdited: "最后编辑时间", unknown: "未知", currentProject: "当前项目",
    deleteWorking: "删除", deletingWorking: "正在删除…", deleteWorkingLabel: "从此浏览器删除 {{name}}",
    deleteWorkingConfirm: "要从此浏览器删除“{{name}}”吗？\n\n此工作副本的 PDF、OCR 结果、校对内容和撤销历史将被永久删除。如需备份，请先保存为 .eduba 文件。\n\n设备上已保存的文件将保留。如果项目当前已打开，将关闭该项目。",
    workingDeleted: "已从此浏览器删除“{{name}}”。", workingDeleteFailed: "无法删除工作副本：{{error}}",
  },
  "zh-Hant": {
    familyLinks: "Kurnugia 系列",
    help: "說明",
    openInNewTab: "在新分頁中開啟",
    resetModel: "恢復基準模型",
    storageProtection: {
      enabled: { title: "儲存資料保護：已啟用", description: "工作內容已受到保護，不會因儲存空間不足而被自動刪除。但是，在瀏覽器設定等位置清除網站資料時，工作內容也會被刪除。" },
      disabled: { title: "儲存資料保護：未啟用", description: "工作內容可能因儲存空間不足或瀏覽器的儲存政策而被自動刪除。" },
      unknown: { title: "儲存資料保護：無法確認", description: "在此環境中，無法確認工作內容是否受到自動刪除保護。" },
    },
    privateBrowsingNotice: "在私密瀏覽模式下，工作內容可能在私密工作階段結束時被刪除。",
    pageCount: "邏輯頁數", dataSize: "資料大小", lastEdited: "最後編輯時間", unknown: "未知", currentProject: "目前的專案",
    deleteWorking: "刪除", deletingWorking: "正在刪除…", deleteWorkingLabel: "從此瀏覽器刪除 {{name}}",
    deleteWorkingConfirm: "要從此瀏覽器刪除「{{name}}」嗎？\n\n此工作副本的 PDF、OCR 結果、校對內容和復原歷程將被永久刪除。如需備份，請先儲存為 .eduba 檔案。\n\n裝置上已儲存的檔案會保留。如果專案目前已開啟，將關閉該專案。",
    workingDeleted: "已從此瀏覽器刪除「{{name}}」。", workingDeleteFailed: "無法刪除工作副本：{{error}}",
  },
} as const;

export const browserResources = {
  en: { ...baseBrowserResources.en, ...workingProjectResources.en },
  ja: { ...baseBrowserResources.ja, ...workingProjectResources.ja },
  "zh-Hans": { ...baseBrowserResources["zh-Hans"], ...workingProjectResources["zh-Hans"] },
  "zh-Hant": { ...baseBrowserResources["zh-Hant"], ...workingProjectResources["zh-Hant"] },
} as const;

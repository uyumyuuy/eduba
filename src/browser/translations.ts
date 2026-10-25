const baseBrowserResources = {
  en: { save: "Save project", saveAs: "Save as…", recover: "Working projects", recoveryTitle: "Open a working project", recoveryDescription: "These copies are saved in this browser. Save a .eduba file to keep a portable copy.", recoveryEmpty: "No working projects are saved in this browser.", localOnly: "PDFs and OCR stay on your device", unsavedFile: "Save changes to the project file", savedFile: "Project file saved", workingSaved: "Working copy saved in this browser." },
  ja: { save: "プロジェクトを保存", saveAs: "名前を付けて保存…", recover: "作業中のプロジェクト", recoveryTitle: "作業中のプロジェクトを開く", recoveryDescription: "このブラウザに保存した作業内容です。持ち運ぶには .eduba ファイルとして保存してください。", recoveryEmpty: "このブラウザに保存したプロジェクトはありません。", localOnly: "PDFとOCRは端末内で処理します", unsavedFile: "ファイルへの保存が必要です", savedFile: "プロジェクトファイル保存済み", workingSaved: "作業内容をこのブラウザに保存しました。" },
  "zh-Hans": { save: "保存项目", saveAs: "另存为…", recover: "工作中的项目", recoveryTitle: "打开工作中的项目", recoveryDescription: "这些副本保存在此浏览器中。请保存为 .eduba 文件以便携带。", recoveryEmpty: "此浏览器中没有保存的项目。", localOnly: "PDF和OCR在您的设备上处理", unsavedFile: "需要保存项目文件", savedFile: "项目文件已保存", workingSaved: "工作副本已保存在此浏览器中。" },
  "zh-Hant": { save: "儲存專案", saveAs: "另存新檔…", recover: "工作中的專案", recoveryTitle: "開啟工作中的專案", recoveryDescription: "這些副本儲存在此瀏覽器中。請儲存為 .eduba 檔案以便攜帶。", recoveryEmpty: "此瀏覽器中沒有儲存的專案。", localOnly: "PDF和OCR在您的裝置上處理", unsavedFile: "需要儲存專案檔案", savedFile: "專案檔案已儲存", workingSaved: "工作副本已儲存在此瀏覽器中。" },
} as const;

const workingProjectResources = {
  en: {
    deleteWorking: "Delete", deletingWorking: "Deleting…", deleteWorkingLabel: "Delete {{name}} from this browser",
    deleteWorkingConfirm: "Delete “{{name}}” from this browser?\n\nIts working PDF, OCR results, corrections, and undo history will be removed permanently. Save a .eduba file first if you need a backup.\n\nFiles already saved on your device are kept. The project will close if it is currently open.",
    workingDeleted: "Deleted “{{name}}” from this browser.", workingDeleteFailed: "Could not delete the working project: {{error}}",
  },
  ja: {
    deleteWorking: "削除", deletingWorking: "削除中…", deleteWorkingLabel: "{{name}} をこのブラウザから削除",
    deleteWorkingConfirm: "「{{name}}」をこのブラウザから削除しますか？\n\nこの作業コピーの PDF・OCR 結果・校正内容・取り消し履歴が削除され、元に戻せません。必要な内容は先に .eduba ファイルとして保存してください。\n\n端末に保存済みのファイルは残ります。現在開いている場合はプロジェクトを閉じます。",
    workingDeleted: "「{{name}}」をこのブラウザから削除しました。", workingDeleteFailed: "作業コピーを削除できませんでした：{{error}}",
  },
  "zh-Hans": {
    deleteWorking: "删除", deletingWorking: "正在删除…", deleteWorkingLabel: "从此浏览器删除 {{name}}",
    deleteWorkingConfirm: "要从此浏览器删除“{{name}}”吗？\n\n此工作副本的 PDF、OCR 结果、校对内容和撤销历史将被永久删除。如需备份，请先保存为 .eduba 文件。\n\n设备上已保存的文件将保留。如果项目当前已打开，将关闭该项目。",
    workingDeleted: "已从此浏览器删除“{{name}}”。", workingDeleteFailed: "无法删除工作副本：{{error}}",
  },
  "zh-Hant": {
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

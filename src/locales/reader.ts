export const readerResources = {
  en: {
    mode: "View mode", proofing: "Proofread", reading: "Read", showPages: "Show pages", hidePages: "Hide pages",
    fontSize: "Text size", previous: "Previous page", next: "Next page", page: "Page", position: "Page {{page}} / {{total}}", exportScope: "Export scope",
    loading: "Loading…", pending: "OCR has not been run on this page.", empty: "No recognized text on this page.",
    imagesLoading: "Loading image…", imagesFailed: "Could not load the page images.", loadFailed: "Could not load this page.", retry: "Retry",
    switchFailed: "Could not switch modes: {{error}}", readOnly: "Reading mode",
  },
  ja: {
    mode: "表示モード", proofing: "校正", reading: "閲覧", showPages: "ページ一覧を表示", hidePages: "ページ一覧を隠す",
    fontSize: "文字サイズ", previous: "前のページ", next: "次のページ", page: "ページ", position: "ページ {{page}} / {{total}}", exportScope: "書き出し範囲",
    loading: "読み込み中…", pending: "このページはOCR未実行です。", empty: "このページに認識されたテキストはありません。",
    imagesLoading: "図表を読み込み中…", imagesFailed: "図表を読み込めませんでした。", loadFailed: "ページを読み込めませんでした。", retry: "再試行",
    switchFailed: "表示モードを切り替えられませんでした：{{error}}", readOnly: "閲覧モード",
  },
  "zh-Hans": {
    mode: "显示模式", proofing: "校对", reading: "阅读", showPages: "显示页面列表", hidePages: "隐藏页面列表",
    fontSize: "字号", previous: "上一页", next: "下一页", page: "页面", position: "第 {{page}} / {{total}} 页", exportScope: "导出范围",
    loading: "正在加载…", pending: "此页面尚未运行 OCR。", empty: "此页面没有识别出的文本。",
    imagesLoading: "正在加载图表…", imagesFailed: "无法加载图表。", loadFailed: "无法加载此页面。", retry: "重试",
    switchFailed: "无法切换显示模式：{{error}}", readOnly: "阅读模式",
  },
  "zh-Hant": {
    mode: "顯示模式", proofing: "校對", reading: "閱讀", showPages: "顯示頁面清單", hidePages: "隱藏頁面清單",
    fontSize: "字級", previous: "上一頁", next: "下一頁", page: "頁面", position: "第 {{page}} / {{total}} 頁", exportScope: "匯出範圍",
    loading: "載入中…", pending: "此頁面尚未執行 OCR。", empty: "此頁面沒有辨識出的文字。",
    imagesLoading: "正在載入圖表…", imagesFailed: "無法載入圖表。", loadFailed: "無法載入此頁面。", retry: "重試",
    switchFailed: "無法切換顯示模式：{{error}}", readOnly: "閱讀模式",
  },
} as const;
